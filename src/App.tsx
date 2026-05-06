import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

type TestState = "idle" | "waiting" | "ready" | "result" | "falseStart";

type Attempt = {
  id: string;
  value: number;
  createdAt: number;
};

type PanelCopy = {
  title: string;
  subtitle: string;
  tone: string;
};

const STORAGE_KEY = "reactionlab:attempts";
const MAX_STORED_ATTEMPTS = 50;
const FIVE_ROUND_TARGET = 5;

const panelCopy: Record<TestState, PanelCopy> = {
  idle: {
    title: "Reaction Time Test",
    subtitle: "Click anywhere to start.",
    tone: "from-indigo-600 via-violet-600 to-fuchsia-600",
  },
  waiting: {
    title: "Wait for green...",
    subtitle: "Stay ready. Do not click yet.",
    tone: "from-rose-600 via-red-600 to-orange-600",
  },
  ready: {
    title: "Click!",
    subtitle: "Now. As fast as you can.",
    tone: "from-emerald-500 via-green-500 to-teal-500",
  },
  result: {
    title: "Nice reaction.",
    subtitle: "Try another round when you are ready.",
    tone: "from-slate-900 via-slate-800 to-zinc-900",
  },
  falseStart: {
    title: "Too soon!",
    subtitle: "Wait until the screen turns green.",
    tone: "from-amber-500 via-orange-500 to-red-500",
  },
};

const readStoredAttempts = (): Attempt[] => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawAttempts = window.localStorage.getItem(STORAGE_KEY);
    if (!rawAttempts) {
      return [];
    }

    const parsed = JSON.parse(rawAttempts);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (attempt): attempt is Attempt =>
          typeof attempt?.id === "string" &&
          Number.isFinite(attempt.value) &&
          Number.isFinite(attempt.createdAt),
      )
      .slice(0, MAX_STORED_ATTEMPTS);
  } catch {
    return [];
  }
};

const getRandomDelay = () => 2_000 + Math.random() * 4_000;

const formatMs = (value: number) => `${Math.round(value)} ms`;

const getAttemptId = () => {
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);

  return `${Date.now()}-${randomId}`;
};

const getPercentileMessage = (value: number) => {
  if (value < 180) {
    return "Extremely fast";
  }
  if (value <= 220) {
    return "Very fast";
  }
  if (value <= 280) {
    return "Average";
  }
  if (value <= 350) {
    return "A bit slow";
  }
  return "Slow";
};

function App() {
  const [testState, setTestState] = useState<TestState>("idle");
  const [attempts, setAttempts] = useState<Attempt[]>(() => readStoredAttempts());
  const [latestResult, setLatestResult] = useState<number | null>(
    () => readStoredAttempts()[0]?.value ?? null,
  );
  const [isFiveRoundMode, setIsFiveRoundMode] = useState(false);
  const [roundResults, setRoundResults] = useState<number[]>([]);

  const timerRef = useRef<number | null>(null);
  const readyAnimationFrameRef = useRef<number | null>(null);
  const readyStartTimeRef = useRef<number | null>(null);
  const readyInputEnabledRef = useRef(false);
  const resultLockedRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const testStateRef = useRef<TestState>("idle");
  const trialIdRef = useRef(0);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearReadyAnimationFrame = useCallback(() => {
    if (readyAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(readyAnimationFrameRef.current);
      readyAnimationFrameRef.current = null;
    }
  }, []);

  const setTestStateSafely = useCallback((nextState: TestState) => {
    testStateRef.current = nextState;
    setTestState(nextState);
  }, []);

  const persistAttempts = useCallback((nextAttempts: Attempt[]) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextAttempts));
    } catch {
      // Storage can be unavailable in private modes; the test still works in memory.
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPendingTimer();
      clearReadyAnimationFrame();
    };
  }, [clearPendingTimer, clearReadyAnimationFrame]);

  useEffect(() => {
    if (testState !== "ready") {
      return;
    }

    const activeTrialId = trialIdRef.current;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = true;

    // React state updates are async, so the timeout only requests the green UI.
    // The timer is armed from the next animation frame after the ready render has
    // committed, keeping input disabled during the tiny paint gap.
    readyAnimationFrameRef.current = window.requestAnimationFrame(() => {
      readyAnimationFrameRef.current = null;

      if (
        trialIdRef.current !== activeTrialId ||
        testStateRef.current !== "ready"
      ) {
        return;
      }

      readyStartTimeRef.current = performance.now();
      readyInputEnabledRef.current = true;
      resultLockedRef.current = false;
    });

    return () => clearReadyAnimationFrame();
  }, [clearReadyAnimationFrame, testState]);

  const stats = useMemo(() => {
    const count = attempts.length;
    const values = attempts.map((attempt) => attempt.value);
    const best = count > 0 ? Math.min(...values) : null;
    const average =
      count > 0 ? values.reduce((sum, value) => sum + value, 0) / count : null;

    return {
      count,
      best,
      average,
      latest: attempts[0]?.value ?? null,
    };
  }, [attempts]);

  const fiveRoundAverage = useMemo(() => {
    if (roundResults.length !== FIVE_ROUND_TARGET) {
      return null;
    }

    return (
      roundResults.reduce((sum, value) => sum + value, 0) / FIVE_ROUND_TARGET
    );
  }, [roundResults]);

  const panel = panelCopy[testState];
  const recentAttempts = attempts.slice(0, 10);
  const currentRound = Math.min(roundResults.length + 1, FIVE_ROUND_TARGET);
  const hasFinishedFiveRound =
    isFiveRoundMode && roundResults.length === FIVE_ROUND_TARGET;
  const isPanelInteractive =
    testState === "idle" || testState === "waiting" || testState === "ready";

  const startTrial = useCallback(() => {
    clearPendingTimer();
    clearReadyAnimationFrame();
    trialIdRef.current += 1;
    const activeTrialId = trialIdRef.current;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = false;
    setLatestResult(null);
    setTestStateSafely("waiting");

    // The delay is intentionally randomized after each start so anticipation cannot
    // be learned. The timeout no longer starts the reaction clock; it only asks
    // React to render the green state. The ready effect above arms timing after
    // that render has reached an animation frame.
    timerRef.current = window.setTimeout(() => {
      if (trialIdRef.current !== activeTrialId) {
        return;
      }

      timerRef.current = null;
      readyStartTimeRef.current = null;
      readyInputEnabledRef.current = false;
      resultLockedRef.current = true;
      setTestStateSafely("ready");
    }, getRandomDelay());
  }, [clearPendingTimer, clearReadyAnimationFrame, setTestStateSafely]);

  const resetToIdle = useCallback(() => {
    clearPendingTimer();
    clearReadyAnimationFrame();
    trialIdRef.current += 1;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = false;
    setLatestResult(null);
    setTestStateSafely("idle");
  }, [clearPendingTimer, clearReadyAnimationFrame, setTestStateSafely]);

  const recordResult = useCallback((inputTime: number) => {
    if (
      resultLockedRef.current ||
      !readyInputEnabledRef.current ||
      readyStartTimeRef.current === null
    ) {
      return;
    }

    // Lock before setting state so rapid double-clicks, touch/click pairs, or key
    // repeat cannot write multiple attempts for the same green screen.
    resultLockedRef.current = true;
    readyInputEnabledRef.current = false;
    const reactionTime = inputTime - readyStartTimeRef.current;
    const roundedReactionTime = Math.max(0, Math.round(reactionTime));
    const nextAttempt: Attempt = {
      id: getAttemptId(),
      value: roundedReactionTime,
      createdAt: Date.now(),
    };

    setLatestResult(roundedReactionTime);
    setAttempts((currentAttempts) => {
      const nextAttempts = [nextAttempt, ...currentAttempts].slice(
        0,
        MAX_STORED_ATTEMPTS,
      );
      persistAttempts(nextAttempts);
      return nextAttempts;
    });
    setRoundResults((currentResults) => {
      if (!isFiveRoundMode || currentResults.length >= FIVE_ROUND_TARGET) {
        return currentResults;
      }

      return [...currentResults, roundedReactionTime];
    });
    readyStartTimeRef.current = null;
    setTestStateSafely("result");
  }, [isFiveRoundMode, persistAttempts, setTestStateSafely]);

  const triggerFalseStart = useCallback(() => {
    clearPendingTimer();
    clearReadyAnimationFrame();
    trialIdRef.current += 1;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = true;
    setLatestResult(null);
    setTestStateSafely("falseStart");
  }, [clearPendingTimer, clearReadyAnimationFrame, setTestStateSafely]);

  const handlePrimaryAction = useCallback((inputTime: number) => {
    if (hasFinishedFiveRound) {
      return;
    }

    const currentState = testStateRef.current;

    if (currentState === "idle") {
      startTrial();
      return;
    }

    if (currentState === "waiting") {
      triggerFalseStart();
      return;
    }

    if (currentState === "ready") {
      recordResult(inputTime);
    }
  }, [
    hasFinishedFiveRound,
    recordResult,
    startTrial,
    triggerFalseStart,
  ]);

  const handlePanelPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const inputTime = performance.now();
    suppressNextClickRef.current = true;

    // Pointer down is used for mouse and touch so the measured input moment is
    // when the user presses, not when a later click fires after release.
    handlePrimaryAction(inputTime);
  };

  const handlePanelClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (performance.now() < suppressClickUntilRef.current) {
      return;
    }

    // Fallback for assistive technology or any browser path that activates the
    // button without a PointerEvent. Pointer-origin clicks are suppressed above.
    handlePrimaryAction(performance.now());
  };

  const handlePanelPointerCancel = () => {
    suppressNextClickRef.current = false;
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    if (!event.repeat) {
      const inputTime = performance.now();
      suppressClickUntilRef.current = inputTime + 1_000;
      handlePrimaryAction(inputTime);
    }
  };

  const handleTryAgain = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (hasFinishedFiveRound) {
      setRoundResults([]);
    }
    resetToIdle();
  };

  const handleFiveRoundToggle = (event: ChangeEvent<HTMLInputElement>) => {
    const isChecked = event.target.checked;
    setIsFiveRoundMode(isChecked);
    setRoundResults([]);
    resetToIdle();
  };

  const handleResetStats = () => {
    clearPendingTimer();
    clearReadyAnimationFrame();
    trialIdRef.current += 1;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = false;
    setAttempts([]);
    setLatestResult(null);
    setRoundResults([]);
    setTestStateSafely("idle");

    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage failures; the visible in-memory stats have been reset.
    }
  };

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <div className="p-4 sm:p-6">
        <section
          className={`relative mx-auto flex min-h-[calc(100svh-2rem)] max-w-7xl select-none flex-col items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br ${panel.tone} p-6 text-center text-white shadow-panel sm:min-h-[calc(100svh-3rem)] sm:p-10`}
          aria-live="polite"
        >
          {isPanelInteractive && !hasFinishedFiveRound && (
            <button
              type="button"
              data-testid="reaction-panel-action"
              className="absolute inset-0 z-10 cursor-pointer touch-manipulation rounded-lg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-[-10px] focus-visible:outline-white/90"
              aria-label={`${panel.title} ${panel.subtitle}`}
              onPointerDown={handlePanelPointerDown}
              onPointerCancel={handlePanelPointerCancel}
              onClick={handlePanelClick}
              onKeyDown={handlePanelKeyDown}
            >
              <span className="sr-only">{panel.title}</span>
            </button>
          )}

          <div className="absolute inset-x-0 top-0 h-1/2 bg-white/10 opacity-60" />
          <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-3 p-4 text-left sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-white/85">
                ReactionLab
              </p>
            </div>

            <label
              className="pointer-events-auto flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/25 bg-white/15 px-4 py-3 text-sm font-semibold text-white shadow-sm backdrop-blur sm:w-auto"
              onClick={(event) => event.stopPropagation()}
            >
              <span>5-round mode</span>
              <input
                type="checkbox"
                checked={isFiveRoundMode}
                onChange={handleFiveRoundToggle}
                className="h-5 w-5 accent-white"
                aria-describedby={
                  isFiveRoundMode ? "five-round-status" : undefined
                }
              />
            </label>
          </header>

          <div className="pointer-events-none relative z-20 flex w-full max-w-3xl flex-col items-center">
            {isFiveRoundMode && (
              <div
                id="five-round-status"
                className="mb-5 rounded-full bg-white/15 px-4 py-2 text-sm font-bold text-white shadow-sm backdrop-blur"
              >
                {hasFinishedFiveRound
                  ? "5 rounds complete"
                  : `Round ${currentRound} of ${FIVE_ROUND_TARGET}`}
              </div>
            )}

            {testState === "result" && latestResult !== null ? (
              <>
                <p className="text-base font-bold uppercase tracking-[0.22em] text-white/80">
                  {getPercentileMessage(latestResult)}
                </p>
                <p className="mt-3 text-7xl font-black leading-none tracking-normal sm:text-8xl">
                  {formatMs(latestResult)}
                </p>
                <p className="mt-5 max-w-xl text-lg font-medium text-white/85 sm:text-xl">
                  {hasFinishedFiveRound && fiveRoundAverage !== null
                    ? `Final 5-round average: ${formatMs(fiveRoundAverage)}`
                    : panel.subtitle}
                </p>
              </>
            ) : hasFinishedFiveRound && fiveRoundAverage !== null ? (
              <>
                <p className="text-base font-bold uppercase tracking-[0.22em] text-white/80">
                  Session average
                </p>
                <p className="mt-3 text-7xl font-black leading-none tracking-normal sm:text-8xl">
                  {formatMs(fiveRoundAverage)}
                </p>
                <p className="mt-5 max-w-xl text-lg font-medium text-white/85 sm:text-xl">
                  Five rounds complete. Start a new set when you are ready.
                </p>
              </>
            ) : (
              <>
                <p className="text-5xl font-black tracking-normal sm:text-7xl">
                  {panel.title}
                </p>
                <p className="mt-5 max-w-xl text-lg font-medium text-white/85 sm:text-2xl">
                  {panel.subtitle}
                </p>
              </>
            )}

            {(testState === "result" ||
              testState === "falseStart" ||
              hasFinishedFiveRound) && (
              <div className="pointer-events-auto mt-8 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={handleTryAgain}
                  className="rounded-lg bg-white px-6 py-3 text-base font-extrabold text-slate-950 shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-100 active:translate-y-0"
                >
                  {hasFinishedFiveRound ? "New 5-round set" : "Try again"}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
        <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
            <StatCard label="Best" value={stats.best} />
            <StatCard label="Average" value={stats.average} />
            <StatCard label="Latest" value={stats.latest} />
            <StatCard label="Attempts" value={stats.count} isCount />
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-black tracking-normal text-slate-950">
                  Recent attempts
                </h2>
                <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
                  Monitor, mouse, keyboard, touch, and browser latency can affect
                  reaction-time results.
                </p>
              </div>
              <button
                type="button"
                onClick={handleResetStats}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-extrabold text-slate-800 transition hover:border-slate-950 hover:bg-slate-950 hover:text-white"
              >
                Reset stats
              </button>
            </div>

            {recentAttempts.length > 0 ? (
              <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {recentAttempts.map((attempt, index) => (
                  <li
                    key={attempt.id}
                    className="rounded-lg bg-slate-100 px-3 py-3 text-center"
                  >
                    <span className="block text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                      #{index + 1}
                    </span>
                    <span className="mt-1 block text-lg font-black text-slate-950">
                      {formatMs(attempt.value)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm font-semibold text-slate-500">
                No attempts yet. Start with the large panel above.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  isCount = false,
}: {
  label: string;
  value: number | null;
  isCount?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-normal text-slate-950 sm:text-3xl">
        {value === null ? "-" : isCount ? value : formatMs(value)}
      </p>
    </div>
  );
}

export default App;
