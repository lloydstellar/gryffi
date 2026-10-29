---
feature_id: guide-knowledge-base
related_features: [ai-guides-overview, guide-step, source-citations, journey-wizard]
---

# Guide Knowledge Base

The Knowledge Base is the foundation of your AI Guide's intelligence. It contains all the content your guide uses to answer questions. Upload static documents to the knowledge base with information your AI Guide can use to give answers.

[[show:overview]]

## Overview

The Knowledge Base:

- Stores your guide's source content
- Powers AI responses
- Enables source citations
- Can be updated anytime
- Supports multiple content types

[[goto:/dashboard/guides]]

## Adding Content

### Document Upload

Upload files for the AI to learn from:

| Format | Max Size | Notes |
|--------|----------|-------|
| PDF | 25 MB | Text extracted automatically |
| Word (.docx) | 25 MB | Formatting preserved |
| PowerPoint | 25 MB | Slides converted to text |
| Text (.txt) | 10 MB | Plain text |
| Markdown (.md) | 10 MB | Formatted text |

### Manual Content

Write content directly:

1. Click "Add Text"
2. Enter a title
3. Write or paste what ever content you want your AI Guide to know
4. Click "Add Knowledge"

### Seeding the Knowledge Base via the Journey Wizard

When you create a journey with the Journey Wizard and upload a document in step 1, you can also ask the wizard to create a new AI Guide and seed that Guide's knowledge base with the same document. The file is processed through the normal knowledge-base pipeline (text extraction, chunking, embedding), so the result is identical to uploading the document manually on the Guide's knowledge-base page. After the wizard finishes, you can add more documents or text to the Guide as usual. See: journey-wizard.

## Content Organization

### View Content

See all knowledge base items:
- Title and description
- Source type
- Date added
- Number of chunks used
- Status of document

### Delete Content

Remove outdated or incorrect content:
- Press the trash icon next to the document or text

## Chunks stored in the database

The documents are brought back to text only. A part of the text is stored in a chunk it the database. Documents can be split in multiple chunks to store in the database. The larger the document, the more chunks used in the database.

## The RAG system

RAG is a framework that provides an AI model with access to external, up-to-date data without the need for expensive retraining. It effectively turns a "closed-book" AI into an "open-book" assistant.

How it works:

1. Retrieval: When a user asks a question, the system searches an external database (like Markdown files, PDFs, or a vector database) for the most relevant snippets of information.

2. Augmentation: These snippets are added to the user’s original prompt as specific context.

3. Generation: The AI uses both its internal logic and this provided context to generate a precise, grounded answer.

Why AI uses it:

1. Accuracy: It minimizes "hallucinations" by forcing the AI to base its answers on facts from the retrieved data.

2. Efficiency: Instead of retraining a model on new information, you simply update the text files in the database.

3. Privacy: It allows the AI to answer questions using private or sensitive data that wasn't part of its original training set.


## Related Features

- [[goto:/dashboard/guides]] - Manage guides
- See: ai-guides-overview, source-citations, journey-wizard
