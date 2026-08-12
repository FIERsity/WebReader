import type { Language } from "./i18n";

export const FEEDBACK_ENDPOINT = "https://feedback.070315.site/feedback";
export const MAX_FEEDBACK_LENGTH = 2000;

export async function submitFeedback(text: string, language: Language): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_FEEDBACK_LENGTH) {
    throw new Error(`Feedback must be 1-${MAX_FEEDBACK_LENGTH} characters.`);
  }

  const response = await fetch(FEEDBACK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: trimmed, product: "WebReader", language }),
  });

  if (!response.ok) throw new Error(`Feedback request failed with HTTP ${response.status}.`);
}
