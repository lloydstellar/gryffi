---
feature_id: form-file-uploads
related_features: [form-step, form-submissions, form-email-settings]
---

# Form File Uploads

Form File Uploads allow users to upload files when submitting forms in your journeys. Uploaded files are stored securely on the Gryffi platform and shared through secure download links.

## Overview

File upload fields enable:

- Document submission (PDF, Word documents, plain text)
- Image uploads (JPEG, PNG, GIF, WebP)
- Audio uploads (MP3)

## Upload Limits

The following limits apply per form submission:

| Limit | Value |
|-------|-------|
| Files per submission | 2 |
| Maximum size per file | 12 MB |
| Maximum total size | 24 MB |

### Allowed File Types

| Category | Formats |
|----------|---------|
| Images | JPEG, PNG, GIF, WebP |
| Documents | PDF, Word (.doc/.docx), plain text (.txt) |
| Audio | MP3 |

## Storage and Download Links

Uploaded files are never attached to the notification email. Instead:

- Files are stored securely on the Gryffi platform, accessible only to your organization.
- The notification email contains a unique, unguessable download link for each uploaded file.
- Download links are valid for **30 days** after submission.
- After a link expires, the file remains available to admins and journey managers in the Analytics Forms tab. See: form-submissions

## Related Features

- [[goto:/dashboard/analytics#forms]] - View form submissions and files
- See: form-step, form-submissions, form-email-settings
