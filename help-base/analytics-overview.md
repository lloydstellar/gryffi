---
feature_id: analytics-overview
related_features: [dashboard, reports, poll-results, form-submissions, end-user-management, end-user-groups]
---

# Analytics Overview

The Analytics dashboard provides comprehensive insights into journey performance, user engagement, and content effectiveness across your organization.

[[show:analytics]]

## Overview

The Analytics page consists of eight tabs:

| Tab | Description |
|-----|-------------|
| Overview | High-level KPIs and trends |
| Journeys | Funnel visualization and step analysis |
| Users | Individual user progress and activity |
| Groups | Group performance comparison |
| Polls | Poll voting results |
| Forms | Form submissions and uploaded files (admins and journey managers only) |
| Rewards | Reward code tracking |
| Reports | PDF report generation |

[[goto:/dashboard/analytics]]

## Overview Tab

The Overview tab displays key performance indicators for the selected time period.

### KPI Cards

| Metric | Description |
|--------|-------------|
| Journeys Started | Total journey starts in period |
| Completion Rate | Percentage of completed journeys |
| Avg. Duration | Average time spent per step |
| Active Users | Unique users with activity |

### Completion Trend

A line chart showing daily journey starts and completions over the selected period.

### Top Performing Journeys

A table ranking journeys by completion count, showing:
- Journey title
- Started count
- Completed count
- Completion rate percentage

## Journeys Tab

Analyze individual journey performance with detailed funnel visualization.

[[goto:/dashboard/analytics#journeys]]

### Funnel Visualization

1. Select a journey from the dropdown
2. View the step-by-step funnel showing:
   - Step title
   - Users who reached each step
   - Drop-off percentage between steps

### Step Analysis

| Data Point | Description |
|------------|-------------|
| Reached | Number of users who reached the step |
| Drop-off | Percentage who didn't continue |
| Avg Time | Average time spent on step |

### Quick Export

Click "Export PDF" next to the journey selector to download a Journey Performance Report for the selected journey.

## Users Tab

Track individual end user progress and engagement.

[[goto:/dashboard/analytics#users]]

### User Overview

The users table shows:
- User name and email
- Group membership (supports multiple groups)
- Journeys completed
- Average quiz score
- Last activity date

### User Details

Click "View Details" on any user to see:
- Personal information
- Journey activity timeline
- Quiz performance statistics
- Video engagement metrics

### Journey Replay

View a detailed timeline of a user's journey experience:

1. Go to Analytics - Users (tab)
2. Search for a specific user
3. If a user have finished a journey they have a Replay button in the Actions collumn
4. Click the Replay button next to View Details
5. View the waterfall timeline showing:
   - Each step visited with duration
   - Quiz attempts and scores
   - Form submissions
   - Video watch progress
   - AI Guide chat sessions

[[goto:/dashboard/analytics#users]]


## Groups Tab

Compare performance across end user groups.

[[goto:/dashboard/analytics#groups]]

### Group Statistics

| Metric | Description |
|--------|-------------|
| Members | Total users in group |
| Active | Users with recent activity |
| Completed | Users who finished journeys |
| Completion Rate | Group completion percentage |
| Avg Quiz Score | Group average on quizzes |

### Group Details

Click "View Details" on any group to see:
- Member list
- Group performance metrics
- Comparison to organization benchmarks

## Polls Tab

View poll results from Poll Steps in your journeys.

[[goto:/dashboard/analytics#polls]]

See: poll-results

## Forms Tab

View form submissions from Form Steps in your journeys, including all responses, submitter details and uploaded files. Because submissions may contain personal data, this tab is only visible to admins and journey managers.

[[goto:/dashboard/analytics#forms]]

See: form-submissions

## Rewards Tab

Track reward code distribution and claims.

[[goto:/dashboard/analytics#rewards]]

### Reward Cards

Each reward shows:
- Reward title and journey
- Total claimed count
- Validity period (if set)
- Archive status

### View Codes

Click "View codes" to see all generated codes and their claim status.

### Download PDF

Click "Download PDF" to export a list of all codes for a specific reward.

## Reports Tab

Generate and download PDF reports.

[[goto:/dashboard/analytics#reports]]

See: reports

## Date Range Filter

Most tabs support a date range filter:
- Last 7 days
- Last 30 days
- Last 90 days

Select the period from the dropdown to update all displayed data.

## Related Features

- [[goto:/dashboard/analytics]] - View analytics dashboard
- [[goto:/dashboard/analytics#reports]] - Generate reports
- See: reports, poll-results, form-submissions, end-user-management, end-user-groups
