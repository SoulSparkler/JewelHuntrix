import { ScanResultCard } from '../ScanResultCard';
import type { Finding } from '@shared/schema';

export default function FindingCardExample() {
  const mockFinding: Finding = {
    id: '1',
    listingId: '12345',
    listingUrl: 'https://www.vinted.com/items/12345',
    listingTitle: 'Vintage Pearl Necklace - Mystery Bundle',
    price: '€15.00',
    confidenceScore: 92,
    aiReasoning: 'Clear 585 hallmark visible on clasp in photo 2. Pearl shows natural luster and irregular surface texture consistent with genuine pearls. Professional craftsmanship evident in setting.',
    detectedMaterials: ["14K Gold", "Real Pearl"],
    reasons: ["585 hallmark detected", "Natural pearl luster", "Professional craftsmanship"],
    isValuable: true,
    lotType: 'vintage_lot',
    searchQueryId: null,
    foundAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    telegramSent: false,
    expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
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
