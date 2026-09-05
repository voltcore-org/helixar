import { createFileRoute } from "@tanstack/react-router";
import { Console } from "@/components/helixar/Console";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="min-h-dvh bg-bg text-fg">
      <Console />
    </main>
  );
}
