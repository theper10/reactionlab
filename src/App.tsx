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

type ConsistencySummary = {
  range: number | null;
  label: string;
  sampleSize: number;
};

type ToneKind = "success" | "error";

const STORAGE_KEY = "reactionlab:attempts";
const MUTE_STORAGE_KEY = "reactionlab:muted";
const MAX_STORED_ATTEMPTS = 50;
const FIVE_ROUND_TARGET = 5;
const GRAPH_ATTEMPT_LIMIT = 20;

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

const readStoredMuteState = () => {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === "true";
  } catch {
    return false;
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

const getConsistencyLabel = (range: number) => {
  if (range <= 40) {
    return "Excellent";
  }
  if (range <= 80) {
    return "Good";
  }
  if (range <= 130) {
    return "Inconsistent";
  }
  return "Very inconsistent";
};

const getConsistencySummary = (attempts: Attempt[]): ConsistencySummary => {
  const recentAttempts = attempts.slice(0, 5).map((attempt) => attempt.value);

  if (recentAttempts.length < 2) {
    return {
      range: null,
      label: "Not enough data yet",
      sampleSize: recentAttempts.length,
    };
  }

  // Consistency is intentionally simple: compare the spread between the fastest
  // and slowest valid reaction from the last five attempts.
  const fastestRecentAttempt = Math.min(...recentAttempts);
  const slowestRecentAttempt = Math.max(...recentAttempts);
  const consistencyRange = slowestRecentAttempt - fastestRecentAttempt;

  return {
    range: consistencyRange,
    label: getConsistencyLabel(consistencyRange),
    sampleSize: recentAttempts.length,
  };
};

const getGraphBarColor = (value: number) => {
  if (value < 180) {
    return "#10b981";
  }
  if (value <= 220) {
    return "#22c55e";
  }
  if (value <= 280) {
    return "#6366f1";
  }
  if (value <= 350) {
    return "#f59e0b";
  }
  return "#ef4444";
};

function App() {
  const [testState, setTestState] = useState<TestState>("idle");
  const [attempts, setAttempts] = useState<Attempt[]>(() => readStoredAttempts());
  const [latestResult, setLatestResult] = useState<number | null>(
    () => readStoredAttempts()[0]?.value ?? null,
  );
  const [isFiveRoundMode, setIsFiveRoundMode] = useState(false);
  const [isMuted, setIsMuted] = useState(() => readStoredMuteState());
  const [roundResults, setRoundResults] = useState<number[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
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
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
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

  const consistency = useMemo(
    () => getConsistencySummary(attempts),
    [attempts],
  );

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

  const playFeedbackTone = useCallback((kind: ToneKind) => {
    if (isMuted || typeof window === "undefined") {
      return;
    }

    try {
      const AudioContextConstructor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioContextConstructor) {
        return;
      }

      const audioContext =
        audioContextRef.current ?? new AudioContextConstructor();
      audioContextRef.current = audioContext;

      // Web Audio is created and resumed only inside user-triggered handlers.
      // Callers calculate timing first, then fire this short tone so audio work
      // cannot influence the measured reaction time.
      void audioContext
        .resume()
        .then(() => {
          const now = audioContext.currentTime;
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const duration = kind === "success" ? 0.1 : 0.13;
          const startFrequency = kind === "success" ? 660 : 220;
          const endFrequency = kind === "success" ? 880 : 120;

          oscillator.type = kind === "success" ? "sine" : "triangle";
          oscillator.frequency.setValueAtTime(startFrequency, now);
          oscillator.frequency.exponentialRampToValueAtTime(
            endFrequency,
            now + duration,
          );

          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.055, now + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(now);
          oscillator.stop(now + duration + 0.02);
        })
        .catch(() => undefined);
    } catch {
      // Audio feedback is optional; timing and UI should never depend on it.
    }
  }, [isMuted]);

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
    playFeedbackTone("success");
  }, [isFiveRoundMode, persistAttempts, playFeedbackTone, setTestStateSafely]);

  const triggerFalseStart = useCallback(() => {
    clearPendingTimer();
    clearReadyAnimationFrame();
    trialIdRef.current += 1;
    readyStartTimeRef.current = null;
    readyInputEnabledRef.current = false;
    resultLockedRef.current = true;
    setLatestResult(null);
    setTestStateSafely("falseStart");
    playFeedbackTone("error");
  }, [
    clearPendingTimer,
    clearReadyAnimationFrame,
    playFeedbackTone,
    setTestStateSafely,
  ]);

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

  const handleMuteToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsMuted((currentValue) => {
      const nextValue = !currentValue;

      try {
        window.localStorage.setItem(MUTE_STORAGE_KEY, String(nextValue));
      } catch {
        // Mute still updates for this session if localStorage is unavailable.
      }

      return nextValue;
    });
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

            <div className="pointer-events-auto flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleMuteToggle}
                aria-label={
                  isMuted ? "Unmute reaction sounds" : "Mute reaction sounds"
                }
                className="rounded-lg border border-white/25 bg-white/15 px-4 py-3 text-sm font-semibold text-white shadow-sm backdrop-blur transition hover:bg-white/25"
              >
                {isMuted ? "Muted" : "Sound on"}
              </button>

              <label
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/25 bg-white/15 px-4 py-3 text-sm font-semibold text-white shadow-sm backdrop-blur"
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
            </div>
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
            <ConsistencyCard consistency={consistency} />
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

        <AttemptsGraph attempts={attempts} />
      </div>
    </main>
  );
}

function ConsistencyCard({
  consistency,
}: {
  consistency: ConsistencySummary;
}) {
  return (
    <div className="col-span-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:col-span-4 lg:col-span-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Consistency
          </p>
          <p className="mt-2 text-2xl font-black tracking-normal text-slate-950 sm:text-3xl">
            {consistency.range === null
              ? "Not enough data"
              : formatMs(consistency.range)}
          </p>
        </div>
        <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-extrabold text-slate-800">
          {consistency.label}
        </div>
      </div>
      <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
        {consistency.range === null
          ? "Complete at least 2 valid attempts to score your range."
          : `Range across last ${consistency.sampleSize} valid attempts. Lower is steadier.`}
      </p>
    </div>
  );
}

function AttemptsGraph({ attempts }: { attempts: Attempt[] }) {
  const graphAttempts = attempts.slice(0, GRAPH_ATTEMPT_LIMIT).reverse();
  const values = graphAttempts.map((attempt) => attempt.value);

  if (graphAttempts.length === 0) {
    return (
      <section
        className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        aria-labelledby="attempts-graph-heading"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="attempts-graph-heading"
              className="text-lg font-black tracking-normal text-slate-950"
            >
              Attempts graph
            </h2>
            <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
              Last valid attempts. Lower milliseconds are better.
            </p>
          </div>
          <p className="text-sm font-bold text-slate-500">
            False starts excluded
          </p>
        </div>
        <div
          className="mt-4 rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm font-semibold text-slate-500"
          role="img"
          aria-label="Attempts graph. No valid attempts yet."
        >
          No valid attempts yet.
        </div>
      </section>
    );
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const graphMin = Math.max(0, minValue - 30);
  const graphMax = Math.max(maxValue + 30, graphMin + 90);
  const width = 640;
  const height = 220;
  const padding = {
    top: 22,
    right: 16,
    bottom: 42,
    left: 46,
  };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const gap = graphAttempts.length > 12 ? 5 : 9;
  const barWidth = Math.max(
    8,
    (innerWidth - gap * Math.max(0, graphAttempts.length - 1)) /
      graphAttempts.length,
  );
  const yForValue = (value: number) =>
    padding.top +
    innerHeight -
    ((value - graphMin) / (graphMax - graphMin)) * innerHeight;
  const zeroLine = padding.top + innerHeight;

  return (
    <section
      className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      aria-labelledby="attempts-graph-heading"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            id="attempts-graph-heading"
            className="text-lg font-black tracking-normal text-slate-950"
          >
            Attempts graph
          </h2>
          <p className="mt-1 text-sm font-medium leading-6 text-slate-600">
            Last {graphAttempts.length} valid attempts. Lower bars are faster.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
          <span>Lower ms is better</span>
          <span aria-hidden="true">/</span>
          <span>False starts excluded</span>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg bg-slate-50 p-3">
        <svg
          className="h-auto w-full"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="attempts-graph-svg-title attempts-graph-svg-desc"
        >
          <title id="attempts-graph-svg-title">
            ReactionLab valid attempts graph
          </title>
          <desc id="attempts-graph-svg-desc">
            A bar chart of recent valid reaction times in milliseconds. Shorter
            bars are faster attempts.
          </desc>

          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top}
            y2={padding.top}
            stroke="#dbe3ee"
            strokeDasharray="4 6"
          />
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={zeroLine}
            y2={zeroLine}
            stroke="#cbd5e1"
          />
          <text
            x={0}
            y={padding.top + 4}
            fill="#64748b"
            fontSize="12"
            fontWeight="700"
          >
            {formatMs(graphMax)}
          </text>
          <text
            x={0}
            y={zeroLine + 4}
            fill="#64748b"
            fontSize="12"
            fontWeight="700"
          >
            {formatMs(graphMin)}
          </text>

          {graphAttempts.map((attempt, index) => {
            const x = padding.left + index * (barWidth + gap);
            const y = yForValue(attempt.value);
            const barHeight = Math.max(2, zeroLine - y);
            const attemptNumber = attempts.length - graphAttempts.length + index + 1;

            return (
              <g key={attempt.id}>
                <title>
                  Attempt {attemptNumber}: {formatMs(attempt.value)}
                </title>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  rx="6"
                  fill={getGraphBarColor(attempt.value)}
                />
                {graphAttempts.length <= 12 && (
                  <text
                    x={x + barWidth / 2}
                    y={Math.max(14, y - 7)}
                    textAnchor="middle"
                    fill="#334155"
                    fontSize="12"
                    fontWeight="800"
                  >
                    {Math.round(attempt.value)}
                  </text>
                )}
              </g>
            );
          })}

          <text
            x={padding.left}
            y={height - 10}
            fill="#64748b"
            fontSize="12"
            fontWeight="700"
          >
            Older
          </text>
          <text
            x={width - padding.right}
            y={height - 10}
            textAnchor="end"
            fill="#64748b"
            fontSize="12"
            fontWeight="700"
          >
            Newer
          </text>
        </svg>

        <ol className="sr-only">
          {graphAttempts.map((attempt, index) => (
            <li key={attempt.id}>
              Attempt {index + 1} of {graphAttempts.length}:{" "}
              {formatMs(attempt.value)}
            </li>
          ))}
        </ol>
      </div>
    </section>
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
