---
feature_id: form-file-uploads
related_features: [form-step, form-submissions, form-email-settings]
---

# Form File Uploads

With a File upload field in a Form Step, participants can send you a file. Uploaded files are stored in Gryffi and shared through secure download links.

## Overview

A File upload field accepts one kind of file. You choose it under **File type** when you add the field:

| File type | Formats |
|-----------|---------|
| **Image** | JPG, PNG, GIF, WebP |
| **Document** | PDF, Word (.doc and .docx), TXT |
| **Audio (MP3)** | MP3 only |

Each File upload field takes one file. A form can have at most 2 File upload fields.

Gryffi reads the format from the file itself, not from the file name. A file that does not match the File type of the field is refused.

Uploaded images are checked for nudity. An image that fails the check is not accepted, and the participant is asked to choose a different image. If the check cannot run at that moment, the participant is asked to try again in a few minutes.

## Upload Limits

These limits apply per form submission:

| Limit | Value |
|-------|-------|
| Files per submission | 2 |
| Maximum size per file | 12 MB |
| Maximum total size | 24 MB |

## Storage and Download Links

Uploaded files are never attached to the notification email. Instead:

- Files are stored in Gryffi. Only your own organization can reach them.
- The notification email has a unique download link for each file. Nobody can guess the link.
- Download links work for **30 days** after the submission.
- After a link has expired, makers can still download the file in Analytics, tab Responses, under Forms.

See: form-submissions

## Related Features

- [[goto:/dashboard/analytics#forms]] - View form submissions and files
- See: form-step, form-submissions, form-email-settings
