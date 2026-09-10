import { create } from 'zustand';
import { useFileStore } from '@/stores/fileStore';
import {
  locateElement,
  planClassEdit,
  planTextEdit,
  type Candidate,
  type LocateResult,
  type Selection,
} from '@/lib/uibuilder/locate';

/**
 * Editing what you can see, by editing the code that made it.
 *
 * There is no second representation here — no design document that later has to
 * be turned into source. A change lands as a write to the project's own file
 * through the ordinary file store, so it goes through `normalizePath`, the
 * protected-path refusal and the read-only check like any other edit, and the
 * preview rebuilds from the code the way it always does.
 *
 * The uncertain part is the *link* between an element and a line, which is a
 * text search rather than a source map. Every edit therefore re-checks the line
 * before writing and refuses when it has moved: a wrong replacement in somebody
 * else's source, reported as a success, is the failure this whole panel has to
 * avoid.
 */

interface UIBuilderState {
  /** Whether the preview is currently in element-picking mode. */
  inspecting: boolean;
  selection: Selection | null;
  located: LocateResult | null;
  chosen: Candidate | null;
  /** What the last edit did, in the past tense, only once it has happened. */
  applied: string | null;
  problem: string | null;

  setInspecting: (inspecting: boolean) => void;
  select: (selection: Selection) => void;
  choose: (candidate: Candidate) => void;
  editText: (text: string) => void;
  editClasses: (classes: string) => void;
  reset: () => void;
}

export const useUIBuilderStore = create<UIBuilderState>()((set, get) => ({
  inspecting: false,
  selection: null,
  located: null,
  chosen: null,
  applied: null,
  problem: null,

  setInspecting: (inspecting) => set({ inspecting }),

  select(selection) {
    const located = locateElement(useFileStore.getState().files, selection);
    set({
      selection,
      located,
      // One unambiguous candidate is the only case where choosing for somebody
      // is safe; anything else waits for them to pick.
      chosen: located.candidates.length === 1 ? located.candidates[0] : null,
      applied: null,
      problem: null,
    });
  },

  choose: (candidate) => set({ chosen: candidate, applied: null, problem: null }),

  editText(text) {
    const { chosen, selection } = get();
    if (!chosen || !selection?.text) {
      set({ problem: 'Select an element with text in the preview first.' });
      return;
    }

    const content = useFileStore.getState().files[chosen.path];
    if (content === undefined) {
      set({ problem: `${chosen.path} is no longer in the project.` });
      return;
    }

    const plan = planTextEdit(content, chosen.line, selection.text, text);
    if (!plan.ok) {
      set({ problem: plan.problem, applied: null });
      return;
    }

    try {
      useFileStore.getState().writeFile(chosen.path, plan.next);
    } catch (failure) {
      set({
        problem: failure instanceof Error ? failure.message : 'The file could not be written.',
        applied: null,
      });
      return;
    }

    set({
      applied: `Wrote ${chosen.path}:${chosen.line}. The preview rebuilds from the file.`,
      problem: null,
      selection: { ...selection, text },
      chosen: { ...chosen, source: plan.after },
    });
  },

  editClasses(classes) {
    const { chosen, selection } = get();
    if (!chosen || !selection) {
      set({ problem: 'Select an element in the preview first.' });
      return;
    }

    const content = useFileStore.getState().files[chosen.path];
    if (content === undefined) {
      set({ problem: `${chosen.path} is no longer in the project.` });
      return;
    }

    const plan = planClassEdit(content, chosen.line, selection.classes.join(' '), classes);
    if (!plan.ok) {
      set({ problem: plan.problem, applied: null });
      return;
    }

    try {
      useFileStore.getState().writeFile(chosen.path, plan.next);
    } catch (failure) {
      set({
        problem: failure instanceof Error ? failure.message : 'The file could not be written.',
        applied: null,
      });
      return;
    }

    set({
      applied: `Wrote ${chosen.path}:${chosen.line}. The preview rebuilds from the file.`,
      problem: null,
      selection: { ...selection, classes: classes.trim().split(/\s+/).filter(Boolean) },
      chosen: { ...chosen, source: plan.after },
    });
  },

  reset: () => set({ selection: null, located: null, chosen: null, applied: null, problem: null }),
}));
