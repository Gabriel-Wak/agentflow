"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Workflow } from "lucide-react";
import { api } from "@/lib/fetcher";
import { Button, Card, Empty, ErrorText } from "../ui";

interface Row { id: string; name: string; updated_at: string; nodes: { type?: string }[] }

export default function FlowList() {
  const router = useRouter();
  const [items, setItems] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Row[]>("/api/flows").then(setItems).catch((e) => setError(e.message));
  }, []);

  async function create() {
    setCreating(true);
    try {
      const { id } = await api<{ id: string }>("/api/flows", { method: "POST", body: JSON.stringify({}) });
      router.push(`/flows/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Excluir este time de agentes e o histórico de execuções?")) return;
    await api(`/api/flows/${id}`, { method: "DELETE" });
    setItems((p) => p?.filter((f) => f.id !== id) ?? null);
  }

  return (
    <div className="space-y-4">
      <Button onClick={create} disabled={creating}>
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Novo time (Criador → Validador → Aprovador)
      </Button>
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
      ) : items.length === 0 ? (
        <Empty>Nenhum time ainda. Crie o primeiro — ele já vem com os 3 agentes ligados.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f) => (
            <Card key={f.id} className="group p-4 hover:border-accent/50">
              <div className="flex items-start justify-between">
                <Link href={`/flows/${f.id}`} className="flex items-center gap-2 font-medium hover:text-accent">
                  <Workflow className="h-4 w-4 text-accent" /> {f.name}
                </Link>
                <Button variant="danger" className="px-2 opacity-0 group-hover:opacity-100" onClick={() => remove(f.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <p className="mt-2 text-xs text-muted">
                {f.nodes.filter((n) => n.type === "agent").length} agente(s) · atualizado {new Date(f.updated_at).toLocaleString("pt-BR")}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
