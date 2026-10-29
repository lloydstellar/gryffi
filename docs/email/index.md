# Email

Gryffi sends magic links to participants, invitations to makers, reminders, password resets and form submissions. Without working email, participants cannot open their journeys.

## SMTP

Fill in your mail server in the setup wizard or on the Installation page:

| Field | |
|---|---|
| Mail server | For example `smtp.example.com` |
| Port | Usually `587` with STARTTLS, or `465` with SSL/TLS |
| Encryption | Must match the port |
| Username and password | Leave empty if the server needs no login |
| Sender | For example `Gryffi <gryffi@example.com>` |

**Send test email** sends a message to your own address. If it fails, the message says what went wrong and how to fix it; see also [Troubleshooting](/troubleshooting/#email).

## Tips

- Use a transactional mail service or the mail server of your organization. Many hosting providers block outgoing port 25.
- The sender address must be one your mail server may send for. Otherwise the server refuses the message, or it ends up in spam.
- Set up SPF and DKIM for the sender's domain, so magic links reach the inbox.

## Nuntly

Gryffi can also send through the API of Nuntly. Choose it under **Mail service** and enter your API key.
