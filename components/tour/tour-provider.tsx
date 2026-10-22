"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { useLook } from "@/components/look-provider";
import { TourLayer } from "@/components/tour/tour-layer";
import { WELCOME_DELAY_MS, WELCOME_SAY_MS, welcomedThisSession } from "@/lib/desk-kirby";
import { readLocalStorage, writeLocalStorage } from "@/lib/safe-storage";
import {
  EMPTY_TOUR_FACTS,
  PART_TWO,
  REPLAY_STOPS,
  TOUR_KEYS,
  TOUR_STEPS,
  parseTourRecord,
  serializeTourRecord,
  tourStep,
  type TourFacts,
  type TourRecord,
  type TourStepId,
} from "@/lib/tour";
import { isPhoneWidth } from "@/lib/tour-layout";

const MUSIC_SRC = "/api/tour-music";
const MUSIC_VOLUME = 0.35;
const MUSIC_FADE_MS = 1400;
/* The desk greeting's welcome wave (components/desk-greeting.tsx) plays before the offer shows. */
const START_AFTER_WELCOME_MS = WELCOME_DELAY_MS + WELCOME_SAY_MS + 300;
const START_AFTER_RETURN_MS = 500;

export type TourEvent = "mode-opened" | "ask-opened";

/** The shelf, handed over by `TourShelfBridge` from inside the shelf's provider. */
export type TourShelfControl = { isOpen: () => boolean; setOpen: (open: boolean) => void };

/** Replay position: -1 is the replay-start bubble, then the stops, then the finish. */
const REPLAY_FINISH = REPLAY_STOPS.length;
/** The pages the tour runs on: the desk and a pack page. */
const TOUR_PATH = /^\/(?:topics\/[^/]+\/reviewers\/[^/]+)?$/;

export type TourApi = {
  /** The step on screen, or null. */
  step: TourStepId | null;
  /** True from Start tour until Done or Skip (the first visit only). */
  running: boolean;
  /** The area whose own Kirby steps aside for the guide. */
  guideArea: "desk" | "pack" | null;
  /** Pages and controls report what they show; fields merge into the facts. */
  report: (partial: Partial<TourFacts>) => void;
  /** A real action that moves Part 2 on. */
  event: (event: TourEvent, kind?: string) => void;
  start: () => void;
  notNow: () => void;
  skip: () => void;
  done: () => void;
  muted: boolean;
  toggleMute: () => void;
  startReplay: () => void;
  replayAvailable: boolean;
  /** The show-me replay from Settings: its stop (1-7) and count, or null outside it. */
  replay: { stop: number | null; total: number } | null;
  /** Replay Back and Next. */
  next: () => void;
  back: () => void;
  bindShelf: (control: TourShelfControl | null) => void;
  /** The music is playing (and not muted), for the floating notes. */
  musicOn: boolean;
};

const TourContext = createContext<TourApi | null>(null);

/** The tour controller, or null outside the provider. */
export function useTour(): TourApi | null {
  return useContext(TourContext);
}

/** Plays the looped tour music from the start of its fade-in level, creating the element once. */
function playMusic(existing: HTMLAudioElement | null): HTMLAudioElement {
  const audio = existing ?? new Audio(MUSIC_SRC);
  audio.loop = true;
  audio.volume = MUSIC_VOLUME;
  audio.muted = readLocalStorage(TOUR_KEYS.muted) === "1";
  void audio.play().catch(() => {
    // A signed-out session or a missing file plays nothing; the tour runs on.
  });
  return audio;
}

function readRecord(): TourRecord | null {
  return parseTourRecord(readLocalStorage(TOUR_KEYS.record));
}

/**
 * Mounted once in the root layout so the music and travel survive the desk to pack
 * navigation. Inert until the desk or a pack page reports facts.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const look = useLook();
  const [loaded, setLoaded] = useState(false);
  const [record, setRecord] = useState<TourRecord | null>(null);
  const [facts, setFacts] = useState<TourFacts>(EMPTY_TOUR_FACTS);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fadeRef = useRef<number | null>(null);
  // Whether the start offer has waited out the desk's welcome wave.
  const [startReady, setStartReady] = useState(false);
  const router = useRouter();
  // The replay never touches `omni-tour`: its position lives here only.
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const shelfRef = useRef<TourShelfControl | null>(null);
  const shelfWas = useRef<boolean | null>(null);
  const deskHref = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // Device state is read after hydration so the server render never guesses it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecord(readRecord());
    setMuted(readLocalStorage(TOUR_KEYS.muted) === "1");
    setLoaded(true);
  }, []);

  const save = useCallback((next: TourRecord) => {
    writeLocalStorage(TOUR_KEYS.record, serializeTourRecord(next));
    setRecord(next);
  }, []);

  const report = useCallback((partial: Partial<TourFacts>) => {
    setFacts((current) => ({ ...current, ...partial }));
  }, []);

  // 2b to 3: the first never-generated pack page she lands on while the tour runs becomes the
  // tour's pack (normally the one she just made on a desk with none).
  const packId = facts.pack?.id ?? null;
  const packHasViews = facts.pack?.hasViews ?? false;
  useEffect(() => {
    if (!record || record.status !== "running" || record.packId || facts.page !== "pack" || !packId) return;
    if (packHasViews) return;
    // Adoption writes the device record (localStorage) once; the state follows it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    save({ ...record, packId });
  }, [record, facts.page, packId, packHasViews, save]);

  const effectiveFacts = useMemo<TourFacts>(() => {
    if (!facts.pack) return facts;
    return { ...facts, pack: { ...facts.pack, isTourPack: Boolean(record?.packId) && record?.packId === facts.pack.id } };
  }, [facts, record]);

  const derived = loaded ? tourStep(record, effectiveFacts) : null;
  const offering = derived === "start" && replayIndex === null;
  useEffect(() => {
    if (!offering) return;
    const timer = window.setTimeout(
      () => setStartReady(true),
      welcomedThisSession() ? START_AFTER_RETURN_MS : START_AFTER_WELCOME_MS,
    );
    return () => window.clearTimeout(timer);
  }, [offering]);

  // In the replay the stop decides the step; facts never do.
  const replayStep: TourStepId | null =
    replayIndex === null
      ? null
      : replayIndex < 0
        ? "start"
        : replayIndex >= REPLAY_FINISH
          ? "finish"
          : REPLAY_STOPS[replayIndex].step;
  const step = replayIndex !== null ? replayStep : derived === "start" && !startReady ? null : derived;

  useEffect(() => {
    if (facts.page === "desk") deskHref.current = facts.latestGeneratedPackHref;
  }, [facts.page, facts.latestGeneratedPackHref]);

  const stopFade = () => {
    if (fadeRef.current !== null) window.clearInterval(fadeRef.current);
    fadeRef.current = null;
  };

  const fadeOutMusic = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    stopFade();
    const from = audio.volume;
    const started = performance.now();
    fadeRef.current = window.setInterval(() => {
      const t = Math.min((performance.now() - started) / MUSIC_FADE_MS, 1);
      audio.volume = from * (1 - t);
      if (t >= 1) {
        stopFade();
        audio.pause();
      }
    }, 50);
  }, []);

  /** Starts the loop; must run inside the click that started the tour (browsers block sound otherwise). */
  const startMusic = useCallback(() => {
    if (look !== "dreamland") return;
    stopFade();
    const fresh = !audioRef.current;
    const audio = playMusic(audioRef.current);
    audioRef.current = audio;
    if (fresh) {
      audio.addEventListener("playing", () => setPlaying(true));
      audio.addEventListener("pause", () => setPlaying(false));
    }
  }, [look]);

  // Leaving Dream Land mid-tour stops the music.
  useEffect(() => {
    if (look !== "dreamland") audioRef.current?.pause();
  }, [look]);

  useEffect(() => () => {
    stopFade();
    audioRef.current?.pause();
  }, []);

  /** Shows a replay stop: the shelf opens for Topics; pack stops open the newest generated pack. */
  const goToStop = useCallback(
    (index: number) => {
      const stop = REPLAY_STOPS[index];
      const shelf = shelfRef.current;
      if (stop) {
        const href = deskHref.current;
        const match = href?.match(/^\/topics\/([^/]+)\/reviewers\/([^/?#]+)/) ?? null;
        if (stop.id === "topics") {
          shelf?.setOpen(true);
        } else if (isPhoneWidth()) {
          // Phones: the drawer would cover the other stops (it comes back at the end).
          shelf?.setOpen(false);
        }
        if (stop.page === "pack" && href && match && !(facts.page === "pack" && facts.pack?.id === match[2])) {
          router.push(href);
        } else if (stop.id === "new-pack" && facts.page !== "desk") {
          router.push(match ? `/?topic=${match[1]}` : "/");
        }
      }
      setReplayIndex(index);
    },
    [facts.page, facts.pack?.id, router],
  );

  const endReplay = useCallback(() => {
    if (shelfWas.current !== null) shelfRef.current?.setOpen(shelfWas.current);
    shelfWas.current = null;
    setReplayIndex(null);
    fadeOutMusic();
  }, [fadeOutMusic]);

  const start = useCallback(() => {
    if (replayIndex !== null) {
      startMusic();
      goToStop(0);
      return;
    }
    save({ status: "running" });
    startMusic();
  }, [replayIndex, goToStop, save, startMusic]);

  const finish = useCallback(
    (status: "done" | "skipped") => {
      if (replayIndex !== null) {
        endReplay();
        return;
      }
      save({ ...(record ?? {}), status });
      fadeOutMusic();
    },
    [replayIndex, endReplay, record, save, fadeOutMusic],
  );

  const notNow = useCallback(() => finish("skipped"), [finish]);
  const skip = useCallback(() => finish("skipped"), [finish]);
  const done = useCallback(() => finish("done"), [finish]);

  const next = useCallback(() => {
    if (replayIndex === null || replayIndex >= REPLAY_FINISH) return;
    if (replayIndex + 1 >= REPLAY_FINISH) setReplayIndex(REPLAY_FINISH);
    else goToStop(replayIndex + 1);
  }, [replayIndex, goToStop]);

  const back = useCallback(() => {
    if (replayIndex === null || replayIndex <= 0) return;
    goToStop(Math.min(replayIndex, REPLAY_FINISH) - 1);
  }, [replayIndex, goToStop]);

  const running = record?.status === "running";

  // The music never plays with nothing on screen to mute or skip it: it waits while the
  // first visit has no step here (the desk during Generate, a pack that isn't the tour's)
  // and off the tour's pages (Sign out lands on /login), and picks up when a step returns.
  // A replay ends off the tour's pages.
  const pathname = usePathname();
  const onTourPage = TOUR_PATH.test(pathname);
  // Landing on her new pack (2b to 3) is not a wait: the pack is adopted on the next render.
  const adopting = running && !record?.packId && facts.page === "pack" && !packHasViews;
  const musicWaits =
    !onTourPage ||
    (running && replayIndex === null && step === null && effectiveFacts.page !== "other" && !adopting);
  const heldRef = useRef(false);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (musicWaits) {
      if (audio.paused) return;
      stopFade();
      audio.pause();
      heldRef.current = true;
    } else if (heldRef.current) {
      heldRef.current = false;
      if (look === "dreamland" && (running || replayIndex !== null)) void audio.play().catch(() => {});
    }
  }, [musicWaits, look, running, replayIndex]);

  const startReplay = useCallback(() => {
    // Opened on a generated pack before any desk visit: that pack shows the study modes.
    const here = facts.page === "pack" && facts.pack?.hasViews ? window.location.pathname : null;
    const href = deskHref.current ?? facts.latestGeneratedPackHref ?? here;
    if (!href) {
      // Nothing generated yet: the first-visit tour runs instead, from where she is.
      save({ status: "running" });
      startMusic();
      return;
    }
    deskHref.current = href;
    shelfWas.current = shelfRef.current?.isOpen() ?? null;
    setReplayIndex(-1);
  }, [facts.latestGeneratedPackHref, facts.page, facts.pack?.hasViews, save, startMusic]);

  useEffect(() => {
    // Leaving the tour's pages ends a replay (the music already waits).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!onTourPage && replayIndex !== null) endReplay();
  }, [onTourPage, replayIndex, endReplay]);

  const bindShelf = useCallback((control: TourShelfControl | null) => {
    shelfRef.current = control;
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    writeLocalStorage(TOUR_KEYS.muted, nextMuted ? "1" : "0");
    setMuted(nextMuted);
    const audio = audioRef.current;
    if (audio) audio.muted = nextMuted;
    // After a reload the music waits for a click: unmuting a running tour starts it.
    if (!nextMuted && (record?.status === "running" || replayIndex !== null) && (!audio || audio.paused)) startMusic();
  }, [muted, record, replayIndex, startMusic]);

  const event = useCallback(
    (kind: TourEvent, mode?: string) => {
      if (!step) return;
      const matches = kind === "ask-opened" ? step === "ask" : step === mode;
      if (!matches) return;
      if (replayIndex !== null) {
        // Pressing the lit control in the replay also moves on.
        if (replayIndex >= 0 && replayIndex < REPLAY_FINISH) next();
        return;
      }
      if (!record || record.status !== "running") return;
      const index = PART_TWO.indexOf(step);
      if (index === -1) return;
      save({ ...record, part2: index + 1 });
    },
    [record, step, replayIndex, next, save],
  );

  // Escape skips the tour unless a dialog, menu or list is open (that closes first).
  const showing = step !== null && step !== "interlude";
  useEffect(() => {
    if (!showing) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open], [role="listbox"][data-open]',
        )
      )
        return;
      if (step === "start") notNow();
      else skip();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showing, step, notNow, skip]);

  // The page under a veiled step is dimmed by the tour, not by a dialog's own backdrop.
  const veiled = showing && step !== null && TOUR_STEPS[step].target !== null && !TOUR_STEPS[step].open;
  useEffect(() => {
    const root = document.documentElement;
    if (veiled) root.dataset.tour = "on";
    else delete root.dataset.tour;
    return () => {
      delete root.dataset.tour;
    };
  }, [veiled]);

  const guideArea: TourApi["guideArea"] =
    step === null || step === "interlude" ? null : effectiveFacts.page === "pack" ? "pack" : effectiveFacts.page === "desk" ? "desk" : null;

  // One Kirby on screen: every other Kirby on the page steps aside while the guide is there
  // (app/globals.css); in 4b only the Study pack Kirby stays, inhaling in his place.
  const guideMark = guideArea === null ? null : step === "generating" ? "handover" : "on";
  useEffect(() => {
    const root = document.documentElement;
    if (guideMark) root.dataset.tourGuide = guideMark;
    else delete root.dataset.tourGuide;
    return () => {
      delete root.dataset.tourGuide;
    };
  }, [guideMark]);

  const canReplay =
    Boolean(facts.latestGeneratedPackHref) ||
    (facts.page === "pack" && Boolean(facts.pack?.hasViews)) ||
    // Only the desk reports the counts; a pack page loaded directly leaves them at 0.
    (facts.page === "desk" && (facts.topics === 0 || facts.packs === 0));

  const replay = useMemo<TourApi["replay"]>(
    () =>
      replayIndex === null
        ? null
        : { stop: replayIndex >= 0 && replayIndex < REPLAY_FINISH ? replayIndex + 1 : null, total: REPLAY_FINISH },
    [replayIndex],
  );

  const value = useMemo<TourApi>(
    () => ({
      step,
      running,
      guideArea,
      report,
      event,
      start,
      notNow,
      skip,
      done,
      muted,
      toggleMute,
      startReplay,
      // Not while the first visit is under way, and only with something to show: a generated
      // pack for the replay, or an empty desk where the first-visit tour has a step.
      replayAvailable: !running && replayIndex === null && canReplay,
      replay,
      next,
      back,
      bindShelf,
      musicOn: playing && !muted,
    }),
    [step, running, guideArea, canReplay, report, event, start, notNow, skip, done, muted, toggleMute, startReplay, replayIndex, replay, next, back, bindShelf, playing],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      <TourLayer />
    </TourContext.Provider>
  );
}
