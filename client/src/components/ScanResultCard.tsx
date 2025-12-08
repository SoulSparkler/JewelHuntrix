import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { hallmarkToPurity } from "@/utils/hallmarkToPurity";
import { timeAgo } from "@/utils/timeAgo";
import { Button } from "./ui/button";
import { Trash2 } from "lucide-react";
import type { Finding, ManualScan } from "@shared/schema";

type ScanResultCardProps = {
  finding: Finding | ManualScan;
  onDelete: () => void;
};

export function ScanResultCard({ finding, onDelete }: ScanResultCardProps) {
  const hallmarkInfo = hallmarkToPurity(finding.aiReasoning);
  const totalCost = parseFloat(finding.price?.replace(/[€,\s]/g, '') || '0') + 4;
  const advice =
    finding.confidenceScore >= 80 && totalCost <= 20
      ? "BUY"
      : finding.confidenceScore >= 60
      ? "MAYBE"
      : "SKIP";

  const timeText = "foundAt" in finding ? `Found ${timeAgo(finding.foundAt)}` : `Scanned ${timeAgo(finding.scannedAt)}`;

  return (
    <Card className="p-4 bg-neutral-900 text-neutral-100 shadow-lg border border-neutral-700">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">{finding.listingTitle}</h2>
        <div className="flex gap-2">
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
          <span>Confidence Score</span>
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

      {hallmarkInfo && (
        <div className="mt-2 text-sm text-gray-300">
          Hallmark {hallmarkInfo.karat} → {hallmarkInfo.percentage}% {hallmarkInfo.metal}
        </div>
      )}

      {/* Display detected materials as badges */}
      <div className="mt-3">
        <p className="text-sm font-medium mb-1">Detected Materials</p>
        <div className="flex gap-2 flex-wrap">
          {finding.detectedMaterials?.map((m: string) => (
            <span key={m} className="bg-amber-600 px-2 py-1 rounded text-xs">
              {m}
            </span>
          )) || <span className="text-gray-400 text-sm">No materials detected</span>}
        </div>
      </div>

      {/* Display reasons as list */}
      <div className="mt-4 border-t border-gray-700 pt-3">
        <p className="font-medium text-sm mb-2">AI Reasoning:</p>
        <ul className="list-disc list-inside text-sm text-gray-300 space-y-1">
          {finding.reasons?.map((reason: string, i: number) => (
            <li key={i}>{reason}</li>
          )) || <li>No reasoning provided</li>}
        </ul>
      </div>

      <div className="mt-4 text-sm">
        <p>
          <span className="opacity-70">Item price:</span> {finding.price || "N/A"}
        </p>
        <p>
          <span className="opacity-70">Shipping:</span> €4.00
        </p>
        <p className="font-semibold">
          Total: €{totalCost.toFixed(2)}
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
