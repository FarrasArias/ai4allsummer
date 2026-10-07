/* The energy impact grade, computed once in App and shown by both the sidebar
   and the header badge, so the two can't disagree.

   Thresholds and the five-prompt deferral follow technical_writeup.md §4.2.
   While deferred the grade shows as "A", as the sidebar always has. The
   average passed in covers the last two prompts (App.tsx, promptWhHistory). */

export type Grade = "A" | "B" | "C" | "D" | "E";

export const GRADE_DEFER_PROMPTS = 5;

export function computeGrade(avgPromptWh: number | null | undefined, promptCount: number): Grade {
    if (promptCount < GRADE_DEFER_PROMPTS) return "A";
    const v = typeof avgPromptWh === "number" ? avgPromptWh : 0;
    if (v <= 0.05) return "A";
    if (v <= 0.15) return "B";
    if (v <= 0.5) return "C";
    if (v <= 1.5) return "D";
    return "E";
}
