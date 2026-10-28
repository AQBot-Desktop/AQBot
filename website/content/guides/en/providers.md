# Configure Providers

AQBot connects to any number of AI providers simultaneously. Each provider has its own API keys, model list, and parameter defaults.

## Supported Providers

AQBot includes first-class support for the following providers. Any service that exposes an OpenAI-compatible API also works out of the box.

| Provider | Example Models |
|----------|---------------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Qwen series |
| **Zhipu AI** | GLM series |
| **xAI** | Grok series |
| **AWS Bedrock** | Claude, Amazon Nova, Meta Llama, and other Bedrock chat models |
| **Any OpenAI-compatible API** | Ollama, vLLM, LiteLLM, third-party relays, etc. |

---

## Adding a Provider

1. Go to **Settings → Providers**.
2. Click the **+** button at the bottom left.
3. Fill in the provider details:

| Field | Description |
|-------|-------------|
| **Name** | A display name for the sidebar (e.g. *OpenAI*) |
| **Type** | Provider type — determines the default base URL and API behavior |
| **Icon** | Optional icon for visual identification |
| **API Key** | The secret key from your provider's dashboard |
| **Base URL** | API endpoint (pre-filled for built-in types, changeable for relays) |
| **API Path** | Request path — defaults to `/v1/chat/completions` |

::: tip
For third-party relay services, keep the type set to **OpenAI** (or the matching upstream type) and change the **Base URL** to the relay's endpoint.
:::

---

## AWS Bedrock

1. Go to **Settings → Providers**, add a provider, and choose **AWS Bedrock**.
2. Enter the AWS Region used by Bedrock, for example `us-east-1`. AQBot uses the official AWS endpoint for that Region; custom endpoint URLs are not supported.
3. Add **AWS Credentials** with an Access Key ID, Secret Access Key, and an optional Session Token for temporary credentials.
4. Click **Sync Models** to list active foundation models in the selected Region that support text output and streaming.

The IAM principal needs at least:

```text
bedrock:ListFoundationModels
bedrock:InvokeModel
bedrock:InvokeModelWithResponseStream
```

Model access must also be enabled for the account and Region in the AWS console. Credential validation calls `ListFoundationModels`, so an `AccessDenied` response can mean the credential is valid but lacks that permission.

The model discovery API does not list every callable identifier. To use a cross-Region or application inference profile, provisioned throughput, or another model ARN, click **Add Model**, keep the type as **Chat**, and enter the inference profile ID or ARN manually.

AQBot uses the Bedrock `Converse` and `ConverseStream` APIs for text, Base64 image input, multi-turn chat, tools, and token usage. The first release does not use the AWS default credential chain and does not support Bedrock embeddings, reranking, image generation, remote image URLs, `extra_body`, or extended-thinking signature persistence.

See the AWS documentation for [Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) and [model discovery](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html).

---

## Importing from a Website Link

Provider websites can offer an **Open in AQBot** link that opens the AQBot desktop app and pre-fills the provider settings. AQBot will switch to **Settings → Providers**, show a confirmation dialog, and import the provider only after the user confirms.

This is useful for API vendors, relay services, private model platforms, and local gateway dashboards that want to help users configure AQBot without copying every field manually.

### User Flow

1. Install and open a version of AQBot that supports provider links.
2. Click the provider's **Open in AQBot** link in your browser.
3. Confirm the provider name, Base URL, provider type, and API key prefix in AQBot.
4. AQBot creates a new provider or reuses an existing provider with the same **Base URL + type**, then adds the API key if it is not already present.

AQBot does not validate the key or fetch models automatically. After importing, click **Fetch Models** or add models manually.

### Link Format

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

Example:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Display name shown in AQBot, for example `OpenAI` or `My Relay` |
| `baseurl` | Yes | Provider Base URL, URL-encoded. Only `http` and `https` are accepted. Query strings and fragments are rejected. |
| `apikey` | Yes | API key to save into AQBot. AQBot shows only a prefix in the confirmation dialog. |
| `type` | Yes | Provider type. Allowed values: `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl` can use AQBot's existing force suffix, for example `https://example.com!`. AQBot stores `api_path` as empty for imported providers and continues to use the default path for the selected provider type.

### Website Configuration

Use `encodeURIComponent` for every dynamic value:

```html
<a id="open-aqbot" href="#">Open in AQBot</a>

<script>
  const provider = {
    name: 'My Relay',
    baseurl: 'https://api.example.com',
    apikey: 'sk-user-key',
    type: 'openai',
  };

  const params = new URLSearchParams({
    name: provider.name,
    baseurl: provider.baseurl,
    apikey: provider.apikey,
    type: provider.type,
  });

  document.getElementById('open-aqbot').href = `aqbot://providers?${params.toString()}`;
</script>
```

If your service lets users generate API keys, create the link only after the user is signed in and has explicitly selected or created a key.

::: warning Security
An API key in a URL may be visible to browser history, logs, extensions, or analytics tools. Do not place provider import links with real keys on public pages, in static HTML, or in third-party tracking redirects. Prefer generating the link on a private account page after user confirmation.
:::

::: tip Testing
Custom URI schemes are registered by the installed desktop app. If `aqbot://...` does not open AQBot, install or rebuild the latest AQBot app first; running only the website or Vite dev server does not register the system scheme.
:::

---

## Importing from CC Switch

AQBot can scan CC Switch provider configurations from Settings -> Providers. Review each candidate, select the importable rows, then import providers, Base URLs, API keys and model lists into AQBot. OAuth-only entries and entries without reusable keys are skipped with a visible reason.

## Advanced Model Request Body

Each model can define extra_body, a JSON object flattened into OpenAI-compatible Chat Completions requests. It is useful for vendor-specific options such as enable_thinking. AQBot validates the JSON and blocks reserved fields such as model, messages, stream, tools and base sampling parameters.

## Multi-Key Rotation

AQBot supports multiple API keys per provider for load distribution and rate-limit avoidance.

### Adding Keys

In the provider detail panel, click **Add Key** to add additional API keys. Each key shows its prefix, creation date, and last-used timestamp.

### How Rotation Works

AQBot rotates through enabled keys automatically using a round-robin index. When a request completes, the rotation index advances to the next key. If a key is disabled or fails validation, it is skipped.

### Validating Keys

Click the **validate** button next to a key to verify it against the provider's API. The validation result and any error message are recorded for reference.

---

## Model Management

### Fetching Models

Click **Fetch Models** in the provider detail panel to pull the full list of available models from the provider's API. The discovered models are added to your local list automatically.

### Adding Models Manually

If a model is not returned by the API (e.g. a fine-tuned model or a new release), you can add it by typing the model ID directly.

### Per-Model Parameters

Each model can have its own default parameter overrides. Open the model's settings to configure:

| Parameter | Description |
|-----------|-------------|
| **Temperature** | Controls randomness (0 = deterministic, higher = more creative) |
| **Max Tokens** | Maximum number of tokens in the response |
| **Top P** | Nucleus sampling threshold |
| **Frequency Penalty** | Reduces repetition of token sequences |
| **Presence Penalty** | Encourages the model to introduce new topics |

### Model Capabilities

AQBot tracks capabilities per model — such as **Vision**, **Function Calling**, and **Reasoning** — and displays them as tags. These capabilities affect which features are available during a conversation.

---

## Custom & Local Endpoints

AQBot works with any endpoint that implements the OpenAI chat completions API.

### Ollama (Local Models)

1. Install and start [Ollama](https://ollama.com/).
2. In AQBot, create a new provider with type **OpenAI**.
3. Set the **Base URL** to `http://localhost:11434`.
4. Click **Fetch Models** to discover the models you have pulled locally.

### vLLM / TGI

Point the **Base URL** to the address of your inference server (e.g. `http://localhost:8000`) and fetch or add models as usual.

### API Relay Services

For relay or aggregator services (e.g. OpenRouter, one-api), set the type to **OpenAI**, enter the relay's base URL, and provide the relay's API key.

### New API

[New API](https://github.com/QuantumNous/new-api) is a self-hosted gateway with no official public Base URL. AQBot includes it as a built-in provider:

1. Open **Settings → Providers** and select **New API**.
2. Enter the root URL of your instance (for example `http://127.0.0.1:3000`). Do not paste a full path such as `/v1/chat/completions`.
3. Add the token issued by your New API admin console.
4. Click **Sync Models**, pick the models you need, then enable the provider.

The default endpoint format is **OpenAI**. New API can convert most upstream models into OpenAI-compatible requests. To call native Claude or Gemini endpoints instead, change **Endpoint Format** in the provider editor.

---

## Default Model Settings

### Default Assistant Model

Go to **Settings → Default Model** to choose the provider and model that new conversations use by default. You can always override the model on a per-conversation basis from the model selector.

### Topic Naming Model

AQBot can automatically generate a title for each conversation. In the default model settings, you can assign a separate, lightweight model for topic naming to save cost and latency. Configure a custom prompt and context window size for title generation.

---

## Next Steps

- [MCP Servers](./mcp) — connect external tools to extend AI capabilities
- [API Gateway](./gateway) — expose your providers as a local API server
