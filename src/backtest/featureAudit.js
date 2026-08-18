export function featureAudit(predictions) {
  const usable = predictions.filter(item => item.model?.components);
  const notes = [];

  const componentRanges = {};
  for (const key of ["ppgH", "ppgA", "gdH", "gdA", "formH", "formA"]) {
    const values = usable.map(item => item.model.components[key]).filter(Number.isFinite);
    componentRanges[key] = values.length
      ? { min: Math.min(...values), max: Math.max(...values) }
      : { min: null, max: null };
  }

  notes.push("PPG, goal difference and recent form are correlated team-strength signals; possible double counting should be reviewed before Stage 4.");
  notes.push("Early-season matches are rejected when pre-match context lacks enough history.");
  notes.push("Draw probability is derived from absolute strength difference; calibration report should be used to detect draw under/overestimation.");
  notes.push("No market odds are used as model features in this diagnostic stage.");

  return {
    sampleSize: usable.length,
    componentRanges,
    notes
  };
}
