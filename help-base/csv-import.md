---
feature_id: csv-import
related_features: [end-user-management, end-user-groups, manual-user-entry]
---

# CSV Import

CSV Import allows you to bulk upload end users to your organization using a spreadsheet file.

[[show:upload]]

## Overview

CSV import enables:

- Bulk user creation
- Update existing users
- Preview before confirming

[[goto:/dashboard/system-settings#users/csv]]

## Preparing Your CSV

### Download Template

1. Go to System Settings → Users → CSV/Excel Import
2. Drag a CSV, Excel or OpenDocument spreadsheet to "Drop your file here"

### Required Columns

File Format Requirements
Supported formats: CSV, Excel (.xlsx, .xls), OpenDocument (.ods)

Your file should have 3 columns:
Column A: First Name
Column B: Last Name
Column C: Email Address

A header row is optional and will be automatically detected

### Example CSV

```csv
first_name,last_name,email_address
John,Doe,johndoe@mycompany.com
Fred,Bucket,fredbucket@mycompany.com
```

## Handling Duplicates

### Duplicate Detection

Users are matched by email address. If an email address is already in the end users of your company, no new user will be made.

## Error Handling

### Common Errors

| Error | Solution |
|-------|----------|
| Invalid email | Check email format |
| Missing required field | Add email column |

## Best Practices

### Data Preparation

- Clean data before import
- Verify email addresses
- Use consistent formatting
- Test with small sample first

## Related Features

- [[goto:/dashboard/system-settings#users/csv]] - Import users
- [[goto:/dashboard/system-settings#users/csv]] - User management
- See: end-user-management, manual-user-entry
