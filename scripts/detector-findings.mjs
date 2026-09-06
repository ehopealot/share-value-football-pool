const supportedIdentifierNames = ["id", "ruleId", "rule", "antipattern"];

export const detectorFindingIds = (value, label = "Detector JSON") => {
  const findings = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.findings)
      ? value.findings
      : undefined;
  if (!findings || findings.some((finding) => !finding || typeof finding !== "object" || Array.isArray(finding))) {
    throw new Error(`${label} must be an array of finding objects or an object with a findings array.`);
  }
  return findings.map((finding) => {
    const identifier = supportedIdentifierNames
      .map((name) => finding[name])
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    if (typeof identifier !== "string") throw new Error(`${label} finding must include a nonblank id, ruleId, rule, or antipattern.`);
    return identifier.trim();
  });
};

export const parseDetectorOutput = (output) => {
  if (!output.trim()) throw new Error("Detector produced no JSON output.");
  let value;
  try { value = JSON.parse(output); }
  catch (error) { throw new Error("Detector produced invalid JSON output.", { cause: error }); }
  detectorFindingIds(value);
  return value;
};
