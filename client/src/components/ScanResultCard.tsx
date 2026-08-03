import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { hallmarkToPurity } from "@/utils/hallmarkToPurity";
import { timeAgo } from "@/utils/timeAgo";
import { Button } from "./ui/button";
import { Trash2, Gem, XCircle, Ban } from "lucide-react";
import { ValuationBadge } from "./ValuationBadge";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Finding, ManualScan } from "@shared/schema";

type ScanResultCardProps = {
  finding: Finding | ManualScan;
  onDelete: () => void;
};

export function ScanResultCard({ finding, onDelete }: ScanResultCardProps) {
  const hallmarkInfo = hallmarkToPurity(finding.aiReasoning);
  const parsedPrice = parseFloat(finding.price?.replace(/[€,\s]/g, '') || '');
  const hasPrice = !isNaN(parsedPrice);
  // Vinted jewellery shipping runs to about €3.50, which the rulesets' risk
  // caps already account for.
  const totalCost = hasPrice ? parsedPrice + 3.5 : NaN;

  // A path's risk budget overrides the score: an unconfirmed bet above the cap
  // is not a buy however good it looks.
  const advice = !finding.buyCandidate
    ? "SKIP"
    : finding.confidenceScore >= 80 && hasPrice && totalCost <= 20
    ? "BUY"
    : finding.confidenceScore >= 60
    ? "MAYBE"
    : "SKIP";

  const isFinding = "foundAt" in finding;
  const timeText = isFinding ? `Found ${timeAgo(finding.foundAt)}` : `Scanned ${timeAgo((finding as ManualScan).scannedAt)}`;

  // Ground truth once the piece is in hand — the only thing that can eventually
  // calibrate the unmarked-suspicion path's weights against reality.
  const outcomeMutation = useMutation({
    mutationFn: (status: string) => {
      const base = isFinding ? "/api/findings" : "/api/manual-scans";
      return apiRequest("POST", `${base}/${finding.id}/outcome`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [isFinding ? "/api/findings" : "/api/manual-scans"] });
    },
  });

  return (
    <Card className="p-4 bg-neutral-900 text-neutral-100 shadow-lg border border-neutral-700">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">{finding.listingTitle}</h2>
        <div className="flex gap-2 flex-wrap justify-end">
          {/* Which valuation path earned the score: brand, scrap, or both */}
          <ValuationBadge path={finding.valuationPath} tag={finding.valuationTag} />

          {/* Lot type badge for vintage/estate */}
          {finding.lotType && finding.lotType !== 'single' && (
            <span className="bg-purple-600 px-2 py-1 rounded text-xs uppercase">
              {finding.lotType.replace('_', ' ')}
            </span>
          )}
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              advice === "BUY"
                ? "bg-green-600"
                : advice === "MAYBE"
                ? "bg-yellow-600"
                : "bg-red-600"
            }`}
          >
            {advice}
          </span>
        </div>
      </div>

      <p className="text-sm mt-1 opacity-80">{timeText}</p>

      <div className="mt-3">
        <div className="flex justify-between text-sm">
          <span>Likely precious (real gold/pearls/gems)</span>
          <span>{finding.confidenceScore}%</span>
        </div>
        <Progress value={finding.confidenceScore} className="h-2 mt-1" />
      </div>

      {/* Display isValuable (broader than just gold) */}
      <div className="mt-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">Likely Valuable:</span>
          <span className={finding.isValuable ? "text-green-500 font-bold" : "text-red-500"}>
            {finding.isValuable ? "Yes" : "No"}
          </span>
        </div>
      </div>

      {/* Scrap path: melt-value detail. Deliberately shows "weight unconfirmed"
          rather than inventing a gram figure to produce a euro number. */}
      {finding.scrapMetal ? (
        <div className="mt-3 rounded border border-amber-700/50 bg-amber-950/30 p-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium capitalize">
              {finding.scrapMetal}
              {finding.scrapPurityMillesimal ? ` ${finding.scrapPurityMillesimal}` : ""}
            </span>
            {finding.underpricedVsMelt && (
              <span className="bg-green-600 px-2 py-0.5 rounded text-xs font-semibold">
                UNDER MELT
              </span>
            )}
          </div>

          {finding.scrapWeightConfirmed && finding.scrapWeightGrams ? (
            <p className="mt-1 text-gray-300">
              Weight {finding.scrapWeightGrams} g (stated by seller)
            </p>
          ) : (
            <p className="mt-1 text-amber-300">
              Weight unconfirmed — ask the seller for the weight in grams
            </p>
          )}

          {finding.meltValueEur ? (
            <p className="mt-1 text-gray-300">
              Melt value ≈ €{finding.meltValueEur}{" "}
              <span className="opacity-70">(upper bound; gross weight includes stones)</span>
            </p>
          ) : (
            <p className="mt-1 text-gray-400">No melt value — needs a confirmed weight and a live spot price.</p>
          )}
        </div>
      ) : (
        hallmarkInfo && (
          <div className="mt-2 text-sm text-gray-300">
            Hallmark {hallmarkInfo.karat} → {hallmarkInfo.percentage}% {hallmarkInfo.metal}
          </div>
        )
      )}

      {/* Path 3: suspicion only. No value is shown here, by design. */}
      {finding.suspicionLevel && (
        <div className="mt-3 rounded border border-sky-700/50 bg-sky-950/30 p-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">Suspected metal — unconfirmed</span>
            <span
              className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${
                finding.suspicionLevel === "high"
                  ? "bg-sky-500 text-black"
                  : finding.suspicionLevel === "medium"
                  ? "bg-sky-700"
                  : "bg-neutral-600"
              }`}
            >
              {finding.suspicionLevel}
            </span>
          </div>

          {finding.suspicionSignals && finding.suspicionSignals.length > 0 && (
            <div className="mt-2 flex gap-1 flex-wrap">
              {finding.suspicionSignals.map((s: string) => (
                <span key={s} className="bg-sky-800 px-1.5 py-0.5 rounded text-xs">
                  {s.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}

          {finding.recommendedAction && (
            <p className="mt-2 text-gray-300">{finding.recommendedAction}</p>
          )}

          <p className="mt-2 text-xs text-sky-300/80">
            Visual suspicion only — not a confirmed material identification. No melt
            value is calculated from this path.
          </p>
        </div>
      )}

      {/* Why a risk budget ruled this out, when it did */}
      {!finding.buyCandidate && finding.suppressedReason && (
        <div className="mt-3 rounded border border-red-800/50 bg-red-950/30 p-2 text-sm text-red-200">
          {finding.suppressedReason}
        </div>
      )}

      {/* Ground truth once the piece is (or isn't) in hand. This is the only
          thing that can eventually check the suspicion path's weights against
          reality — nothing else records what actually happened. */}
      <div className="mt-3 border-t border-gray-800 pt-3">
        {finding.outcomeStatus ? (
          <p className="text-xs text-gray-400">
            Outcome recorded:{" "}
            <span
              className={
                finding.outcomeStatus === "confirmed_precious"
                  ? "text-green-400 font-medium"
                  : finding.outcomeStatus === "confirmed_costume"
                  ? "text-red-400 font-medium"
                  : "text-gray-300 font-medium"
              }
            >
              {finding.outcomeStatus.replace(/_/g, " ")}
            </span>
            {finding.outcomeNote ? ` — ${finding.outcomeNote}` : ""}
          </p>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">In hand?</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={outcomeMutation.isPending}
              onClick={() => outcomeMutation.mutate("confirmed_precious")}
              data-testid="button-outcome-precious"
            >
              <Gem className="w-3 h-3" /> Precious
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={outcomeMutation.isPending}
              onClick={() => outcomeMutation.mutate("confirmed_costume")}
              data-testid="button-outcome-costume"
            >
              <XCircle className="w-3 h-3" /> Costume
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={outcomeMutation.isPending}
              onClick={() => outcomeMutation.mutate("not_purchased")}
              data-testid="button-outcome-not-purchased"
            >
              <Ban className="w-3 h-3" /> Didn't buy
            </Button>
          </div>
        )}
      </div>

      {/* Key tells / flags as badges */}
      {finding.detectedMaterials && finding.detectedMaterials.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium mb-1">Key Tells</p>
          <div className="flex gap-2 flex-wrap">
            {finding.detectedMaterials.map((m: string, i: number) => (
              <span key={`${m}-${i}`} className="bg-amber-600 px-2 py-1 rounded text-xs">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Full expert breakdown (long-form analysis stored in aiReasoning) */}
      <div className="mt-4 border-t border-gray-700 pt-3">
        <p className="font-medium text-sm mb-2">Expert Analysis</p>
        <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
          {finding.aiReasoning || "No analysis provided"}
        </div>
      </div>

      <div className="mt-4 text-sm">
        <p>
          <span className="opacity-70">Item price:</span> {finding.price || "N/A"}
        </p>
        <p>
          <span className="opacity-70">Shipping:</span> €3.50
        </p>
        <p className="font-semibold">
          Total: {hasPrice ? `€${totalCost.toFixed(2)}` : "—"}
        </p>
      </div>

      <div className="mt-4 flex gap-2">
        <a
          href={finding.listingUrl}
          target="_blank"
          className="flex-1 bg-green-600 hover:bg-green-700 text-center py-2 rounded-lg text-white"
        >
          View Listing
        </a>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          data-testid="button-delete-finding"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}
