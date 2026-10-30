---
feature_id: form-submissions
related_features: [form-step, form-email-settings, form-file-uploads, analytics-overview]
---

# Form Submissions

Form Submissions show all responses submitted through Form Steps in your journeys. They are available in the **Forms** tab of the Analytics dashboard.

## Overview

Every form submission is stored securely on the Gryffi platform and is strictly organization-scoped: only your own organization can ever access its submissions. This applies to submissions from:

- Private journeys (accessed through magic-link invitations)
- Public journeys

Submissions made in journey preview are emailed to the configured recipient but are not stored in the statistics. Without a recipient, nothing is sent in preview. See: journey-preview

[[goto:/dashboard/analytics#forms]]

## Who Can View Submissions

Because form submissions may contain personal data, the Forms tab is only visible to makers with the **Admin** or **Journey Manager** role. Editors and viewers cannot see form submissions. Downloading uploaded files is restricted to admins and journey managers of the owning organization as well.

See: maker-roles

## Viewing Submissions

### Access Form Submissions

1. Go to Analytics → Forms
2. Use the journey filter dropdown to narrow down to a specific journey
3. The count badge shows the number of submissions

### Submission Details

Each submission shows:

| Detail | Description |
|--------|-------------|
| Journey and form title | The journey and Form Step the submission belongs to |
| Responses | All answers given by the submitter |
| Submitter | Name and email address of the submitter |
| Date and time | When the form was submitted |
| Email status | Whether the notification email was sent |
| Private/Public badge | Whether the submission came from a private (invited) or public journey |

### Uploaded Files

If the form contains file upload fields, each submission lists the uploaded files with:

- File name
- File size
- A download button

Files remain downloadable here even after the secure download links in the notification email have expired (links are valid for 30 days). See: form-file-uploads

## Retention

Submissions are retained even if the journey or the Form Step is later deleted. The journey and step titles are archived with the submission, so you can always trace where a response came from.

## Delivery Reliability

The submission is always saved before the notification email is sent. If the email cannot be delivered, the submission still appears in the Forms tab, so no responses are lost. See: form-email-settings

## Related Features

- [[goto:/dashboard/analytics#forms]] - View form submissions
- See: form-step, form-email-settings, form-file-uploads, analytics-overview
