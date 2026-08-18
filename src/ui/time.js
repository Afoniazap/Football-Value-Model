import { UI_TIME_ZONE } from "../config/constants.js";

export function formatKyivDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: UI_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatKyivDateLabel(value) {
  return `${formatKyivDate(value)} Europe/Kyiv`;
}
