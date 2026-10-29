# AI providers

These parts of Gryffi use a language model:

- AI guides, in journeys and on their own
- the journey wizard, which drafts a journey from a document
- Copy & Translate
- descriptions of images, so guides can talk about them (optional)
- reading steps aloud with AI voices (optional; without it, the browser reads aloud)
- the help assistant for makers

Everything else works without AI. You can leave AI off in the setup wizard and add it later on the Installation page.

## Any OpenAI-compatible API

Gryffi talks to the OpenAI API format, which most providers and local model servers support. You need the API address, a key, a chat model and an embedding model.

| Provider | API address | Notes |
|---|---|---|
| Mistral | `https://api.mistral.ai/v1` | Processes data in the EU. Embedding model `mistral-embed` |
| OpenAI | `https://api.openai.com/v1` | Embedding model `text-embedding-3-small` |
| OpenRouter | `https://openrouter.ai/api/v1` | Has no embeddings: set a separate embedding provider |
| Ollama | `http://host.docker.internal:11434/v1` | On the same server. Any API key works. Embedding model for example `nomic-embed-text` |
| vLLM, LM Studio and others | The address of their OpenAI-compatible endpoint | |

Press **Test connection**: Gryffi lists the models of your provider, so you can pick the chat model from that list.

Gryffi runs in a container. `localhost` there is the container itself, not your server. For a model server on the same machine use `host.docker.internal`, and make sure that server listens on an address the container can reach (for Ollama: `OLLAMA_HOST=0.0.0.0`).

## Embeddings

AI guides search your documents with embeddings. Gryffi stores vectors of up to 1536 numbers; models with shorter vectors work too. Models with longer vectors, such as `text-embedding-3-large`, do not.

When you change the embedding model or provider, Gryffi rebuilds the index of all knowledge sources. The Installation page shows the progress. Until it is done, guides find fewer answers.

## Costs and limits

You pay your provider for what Gryffi uses. To keep costs in hand, set **Maximum AI questions per month** on the Installation page. Admins get an email at 80% and at 100%.

## What goes to the provider

Questions of participants, the matching parts of your documents, and the text of journeys you translate or generate go to the provider you chose. Choose a provider whose terms fit your data, or run models yourself.
