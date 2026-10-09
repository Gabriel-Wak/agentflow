import Sidebar from "@/components/Sidebar";
import { requireUser } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar email={user.email ?? ""} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
