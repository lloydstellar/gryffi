---
feature_id: form-email-settings
related_features: [form-step, form-submissions, form-file-uploads, journey-wizard]
---

# Form Email Settings

Form Email Settings decide where the notification email of a Form Step goes. Every time a participant submits the form, Gryffi sends the answers to the email address you set here.

## Configuration

### Step 1: Set the recipient

1. Open the Form Step.
2. Go to the **What they see** tab.
3. Find **Send form to**.
4. Type the email address.

### Step 2: Email subject

You can change the text in **Email subject**. You can use these variables:

- `{{journey_title}}`: the title of the journey
- `{{step_title}}`: the title of the Form Step

Gryffi fills them in for private journeys, public journeys and the preview. The default subject is "Form submission: {{journey_title}}".

### No recipient

Leave **Send form to** empty if you only want to see the answers in Analytics. Participants can still submit the form and continue the journey. The submission is saved on the Forms tab in Analytics, and no email is sent.

See: form-submissions

## Notification Email Contents

The notification email contains:

- All answers
- The name and email address of the participant who submitted the form
- A download link for each uploaded file

Uploaded files are never attached to the email. Each file is stored in Gryffi, and the email has a unique download link per file. Download links work for **30 days**. After that, makers can still download the files on the Forms tab in Analytics.

See: form-file-uploads, form-submissions

### Email Language

The notification email is in the **Default organization language**. You set it on the Organization page: English, Dutch, German, French or Spanish. If it is set to **Use each maker's browser language**, the email is in English.

See: language-settings

### Delivery Reliability

The submission is always saved before the email is sent. If the email cannot be delivered, the submission is not lost. It stays on the Forms tab in Analytics, marked "Email not sent".

See: form-submissions

## Default Recipient for Wizard-Generated Forms

When the Journey Wizard creates a Form Step, **Send form to** is filled in with the email address of the maker who ran the wizard. So you get the answers by email right away, also when you test the journey in the preview. You can change the address at any time with the steps above.

See: journey-wizard, form-step

## Related Features

- [[goto:/dashboard/journeys]] - Journey builder
- [[goto:/dashboard/analytics#forms]] - View form submissions
- See: form-step, form-submissions, form-file-uploads, journey-wizard
