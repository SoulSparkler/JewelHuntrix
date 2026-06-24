import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

interface AddSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { url: string; label: string; frequency: number; threshold: number }) => void;
  editData?: { url: string; label?: string; frequency: number; threshold: number } | null;
}

export default function AddSearchDialog({ open, onOpenChange, onSubmit, editData }: AddSearchDialogProps) {
  const [url, setUrl] = useState(editData?.url || "");
  const [label, setLabel] = useState(editData?.label || "");
  const [frequency, setFrequency] = useState(editData?.frequency?.toString() || "3");
  const [threshold, setThreshold] = useState(editData?.threshold?.toString() || "80");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      url,
      label: label.trim(),
      frequency: parseInt(frequency),
      threshold: parseInt(threshold)
    });
    setUrl("");
    setLabel("");
    setFrequency("3");
    setThreshold("80");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[525px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editData ? 'Edit' : 'Add'} Search Query</DialogTitle>
            <DialogDescription>
              {editData ? 'Update' : 'Configure'} your Vinted search URL and scan preferences
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="search-label">Search Name</Label>
              <Input
                id="search-label"
                placeholder="e.g. Gold brooches, Silver rings, Estate lots"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                data-testid="input-search-label"
              />
              <p className="text-xs text-muted-foreground">
                Give this search a recognizable name (optional — defaults to the search text)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="search-url">Vinted Search URL</Label>
              <Input
                id="search-url"
                type="url"
                placeholder="https://www.vinted.com/catalog?search_text=..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                data-testid="input-search-url"
              />
              <p className="text-xs text-muted-foreground">
                Copy the full URL from your Vinted search results
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="frequency">Scan Frequency</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger id="frequency" data-testid="select-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Every 1 hour</SelectItem>
                    <SelectItem value="3">Every 3 hours</SelectItem>
                    <SelectItem value="6">Every 6 hours</SelectItem>
                    <SelectItem value="12">Every 12 hours</SelectItem>
                    <SelectItem value="24">Every 24 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="threshold">Confidence Min (%)</Label>
                <Input
                  id="threshold"
                  type="number"
                  min="0"
                  max="100"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  data-testid="input-threshold"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" data-testid="button-submit">
              {editData ? 'Update' : 'Add'} Search
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
