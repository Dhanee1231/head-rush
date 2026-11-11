/* Rule changes D approved after f292a66.
   identity.mjs and replay.mjs (capture) apply these exact edits to the f292a66 game before they compare,
   so everything else stays locked to that commit. Each edit must match the f292a66 text exactly once.
   Add an entry only for a rule change D has approved, and say when. Never add one to get a test to pass. */
export const APPROVED = [
  {
    why: 'Smoother difficulty ramp (second bar sooner, split bars one level later). Approved by D on 2026-11-10.',
    edits: [
      ["bars: [3, 6], survAdds: [30, 60, 100, 140],", "bars: [2, 5], splitLv: 4, survAdds: [20, 50, 90, 130],"],
      ["bars: [2, 4, 6], survAdds: [20, 40, 70, 100, 140],", "bars: [1, 3, 7], splitLv: 5, survAdds: [10, 30, 70, 100],"],
      ["bars: [1, 3, 5, 7], survAdds: [10, 25, 45, 70, 100],", "bars: [1, 2, 6], splitLv: 5, survAdds: [10, 20, 70, 100],"],
      ["lv >= 4 && (g.splits || 0) < Math.min(2, 1 + Math.floor((lv - 4) / 4)) && addSplit()", "lv >= g.D.splitLv && (g.splits || 0) < Math.min(2, 1 + Math.floor((lv - g.D.splitLv) / 4)) && addSplit()"]
    ]
  }
];
export function withApproved(src) {
  for (const change of APPROVED) {
    for (const [from, to] of change.edits) {
      const hits = src.split(from).length - 1;
      if (hits !== 1) throw new Error('approved edit matched ' + hits + ' times: ' + from);
      src = src.replace(from, () => to);
    }
  }
  return src;
}
