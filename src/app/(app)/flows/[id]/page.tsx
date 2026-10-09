import FlowEditor from "@/components/flow/FlowEditor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FlowEditor id={id} />;
}
