import { ErrorState } from "./components/ErrorState";
import { LinkCard } from "./components/shell/LinkCard";
import { TabBar, TopBar } from "./components/shell/TopBar";
import { useHashRoute } from "./state/hooks";
import { ExpensoProvider, useExpenso } from "./state/store";
import { AssistantView } from "./views/AssistantView";
import { ExpensesView } from "./views/ExpensesView";
import { PolicyView } from "./views/PolicyView";

function Frame() {
  const { state, actions } = useExpenso();
  const route = useHashRoute();

  if (state.status === "boot_failed") {
    return (
      <div className="grid min-h-dvh place-items-center px-6">
        <div className="max-w-md">
          <h1 className="mb-3 text-xl font-medium">Expenso could not start</h1>
          <ErrorState onRetry={actions.boot}>
            The server did not answer. It may be waking up, or your connection may be down.
          </ErrorState>
        </div>
      </div>
    );
  }

  const workspace = route === "assistant" || route === "desk";
  const hasSlip = !!state.desk?.currentSlip || !!state.desk?.pendingReceipt;

  return (
    // The workspace fills the screen and scrolls inside its panes; the other pages scroll as documents.
    <div className={`flex flex-col ${workspace ? "h-dvh" : "min-h-dvh"}`}>
      <TopBar route={route} />

      {state.status === "booting" ? (
        <div className="flex-1 px-4 py-10 sm:px-8" aria-busy="true" aria-label="Loading your workspace">
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="skeleton h-10 w-72" />
            <div className="skeleton h-5 w-96 max-w-full" />
            <div className="skeleton h-40" />
          </div>
        </div>
      ) : route === "expenses" ? (
        <ExpensesView />
      ) : route === "policy" ? (
        <PolicyView />
      ) : (
        <AssistantView show={route === "desk" ? "desk" : "conversation"} />
      )}

      <TabBar route={route} hasSlip={hasSlip} />
      <LinkCard />
    </div>
  );
}

export default function App() {
  return (
    <ExpensoProvider>
      <Frame />
    </ExpensoProvider>
  );
}
