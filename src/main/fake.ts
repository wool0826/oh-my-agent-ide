// Fake agent mode (decision 127): set by the test harness in the environment, never by the app.
// With it on, no session reaches a model and nothing in the app calls Anthropic, OpenAI or GitHub's release API.
export const fakeMode = () => process.env.OMA_FAKE_AGENT === '1';
