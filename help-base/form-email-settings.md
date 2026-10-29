---
feature_id: form-email-settings
related_features: [form-step, form-submissions, form-file-uploads, email-templates, journey-wizard]
---

# Form Email Settings

Form Email Settings determine where the notification email for a Form Step is sent. Every time an end user submits the form, Gryffi sends the responses to the recipient email address configured here.

## Configuration

### Step 1: Access Settings

1. Open Form Step
2. Go to Settings tab
3. Find "Send form to"
4. Type the email address

### Step 2: Email subject

You can change the email subject. You can use the variable '{{journey_title}}' here.

## Notification Email Contents

The notification email contains:

- All form responses
- The name and email address of the submitter
- Secure download links for any uploaded files

Uploaded files are never attached to the email itself. Instead, each file is stored securely on the Gryffi platform and the email contains a unique, unguessable download link per file. Download links are valid for **30 days**. After they expire, admins and journey managers can still download the files from the Analytics Forms tab. See: form-file-uploads, form-submissions

### Email Language

The notification email is sent in your organization's default language. All 14 journey player languages are supported (English, Dutch, German, French, Spanish, Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian and Turkish). See: language-settings

### Delivery Reliability

The submission is always saved before the email is sent. If the notification email cannot be delivered, the submission is not lost — it remains available in Analytics → Forms. See: form-submissions

## Default Recipient for Wizard-Generated Forms

When a Form Step is created through the Journey Wizard, the **Send form to** field is automatically pre-filled with the email address of the maker who ran the wizard. This ensures the form is submittable in the preview and by end users immediately, without an extra configuration step. You can change the recipient at any time through the steps above — the wizard value is only a sensible default, not a fixed setting.

See: journey-wizard, form-step

## Related Features

- [[goto:/dashboard/journeys]] - Journey builder
- [[goto:/dashboard/analytics#forms]] - View form submissions
- See: form-step, form-submissions, form-file-uploads, journey-wizard
