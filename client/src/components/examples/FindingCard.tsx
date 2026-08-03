import { ScanResultCard } from '../ScanResultCard';
import type { Finding } from '@shared/schema';

export default function FindingCardExample() {
  const mockFinding: Finding = {
    id: '1',
    listingId: '12345',
    listingUrl: 'https://www.vinted.com/items/12345',
    listingTitle: 'Vintage Art Deco Gold Ring with Diamonds',
    price: '€25.00',
    confidenceScore: 87,
    aiReasoning: 'Clear 585 hallmark on inner band. Art Deco geometric setting with old mine cut diamonds. Vintage prong construction and patina consistent with 1920s-1930s era.',
    detectedMaterials: ["gold", "diamonds"],
    reasons: ["585 hallmark detected", "Art Deco geometric design", "Old mine cut diamonds", "Vintage construction methods"],
    isValuable: true,
    lotType: 'mixed',
    sellerCountry: 'Nederland',
    searchQueryId: null,
    foundAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    telegramSent: false,
    expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    lastScannedAt: null,
    scanIntervalMinutes: 90,
    // Scored by the scrap path: a readable 585 mark plus a seller-stated
    // weight, which is what makes the melt figure (and the flag) legitimate.
    valuationPath: 'scrap_path',
    valuationTag: 'Scrap value',
    valuationScore: 92,
    scrapMetal: 'gold',
    scrapPurityMillesimal: 585,
    scrapWeightGrams: '3.20',
    scrapWeightConfirmed: true,
    meltValueEur: '196.56',
    underpricedVsMelt: true,
    // Path 3 fields stay empty: this example was scored from a visible mark,
    // so the unmarked-suspicion path never ran.
    suspicionLevel: null,
    suspicionSignals: [],
    recommendedAction: null,
    buyCandidate: true,
    suppressedReason: null,
    outcomeStatus: null,
    outcomeNote: null,
    outcomeRecordedAt: null
  };

  return (
    <div className="p-6 max-w-md">
      <ScanResultCard
        finding={mockFinding}
        onDelete={() => console.log('Delete finding')}
      />
    </div>
  );
}
