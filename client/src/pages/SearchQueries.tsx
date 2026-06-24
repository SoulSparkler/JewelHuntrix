import { Button } from "@/components/ui/button";
import SearchQueryCard from "@/components/SearchQueryCard";
import AddSearchDialog from "@/components/AddSearchDialog";
import { Plus, Search as SearchIcon } from "lucide-react";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { SearchQuery } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export default function SearchQueries() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: searches = [], isLoading } = useQuery<SearchQuery[]>({
    queryKey: ["/api/searches"],
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/searches/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/searches"] });
      toast({ title: "Search deleted successfully" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<SearchQuery> }) =>
      apiRequest("PUT", `/api/searches/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/searches"] });
    },
  });

  const triggerMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/searches/${id}/trigger`),
    onSuccess: () => {
      toast({ title: "Scan started", description: "Check findings in a few moments" });
    },
  });

  const createSearchMutation = useMutation({
    mutationFn: (data: { url: string; label: string; frequency: number; threshold: number }) => {
      let fallbackLabel = "Custom Search";
      try { fallbackLabel = new URL(data.url).searchParams.get("search_text") || fallbackLabel; } catch {}
      return apiRequest("POST", "/api/searches", {
        vintedUrl: data.url,
        searchLabel: data.label || fallbackLabel,
        scanFrequencyHours: data.frequency,
        confidenceThreshold: data.threshold,
        isActive: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/searches"] });
      toast({ title: "Search query added successfully" });
    },
  });

  const getStatus = (search: SearchQuery): "active" | "paused" | "scanning" => {
    if (!search.isActive) return "paused";
    return "active";
  };

  if (isLoading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold" data-testid="heading-searches">Search Queries</h1>
          <p className="text-muted-foreground mt-1">
            Manage your monitored Vinted searches
          </p>
        </div>
        <Button
          onClick={() => setAddDialogOpen(true)}
          className="gap-2"
          data-testid="button-add-search"
        >
          <Plus className="w-4 h-4" />
          Add Search
        </Button>
      </div>

      {searches.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {searches.map((search) => (
            <SearchQueryCard
              key={search.id}
              searchLabel={search.searchLabel}
              vintedUrl={search.vintedUrl}
              scanFrequency={search.scanFrequencyHours}
              confidenceThreshold={search.confidenceThreshold}
              isActive={search.isActive}
              lastScannedAt={search.lastScannedAt}
              status={getStatus(search)}
              onToggle={() => updateMutation.mutate({ 
                id: search.id, 
                data: { isActive: !search.isActive } 
              })}
              onEdit={() => {}}
              onDelete={() => deleteMutation.mutate(search.id)}
              onTrigger={() => triggerMutation.mutate(search.id)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <SearchIcon className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No search queries yet</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">
            Add your first Vinted search URL to start monitoring for valuable jewelry listings
          </p>
          <Button onClick={() => setAddDialogOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Add Your First Search
          </Button>
        </div>
      )}

      <AddSearchDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSubmit={(data) => createSearchMutation.mutate(data)}
      />
    </div>
  );
}
