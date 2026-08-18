export function redFlag(code, severity, message, source) {
  return { code, severity, message, source };
}

export const Severity = Object.freeze({
  INFO: "INFO",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH"
});
