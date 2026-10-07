/* The energy impact grade, computed once in App and shown by both the sidebar
   and the header badge, so the two can't disagree.

   Follows technical_writeup.md §4.2: the thresholds below, applied to the
   average energy of the last GRADE_WINDOW prompts, and deferred until
   GRADE_DEFER_PROMPTS prompts have been sent (shown as "A" until then). */

export type Grade = "A" | "B" | "C" | "D" | "E";

export const GRADE_DEFER_PROMPTS = 5;

// How many recent prompts the grade averages over
export const GRADE_WINDOW = 5;

export function computeGrade(avgPromptWh: number | null | undefined, promptCount: number): Grade {
    if (promptCount < GRADE_DEFER_PROMPTS) return "A";
    const v = typeof avgPromptWh === "number" ? avgPromptWh : 0;
    if (v <= 0.05) return "A";
    if (v <= 0.15) return "B";
    if (v <= 0.5) return "C";
    if (v <= 1.5) return "D";
    return "E";
}
