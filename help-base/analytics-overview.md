---
feature_id: analytics-overview
related_features: [dashboard, reports, poll-results, reward-tracking, form-submissions, end-user-management, end-user-groups, trash]
---

# Analytics Overview

Analytics shows how your journeys perform, how participants progress and what they answered.

![Analytics: the tabs (1), the period (2), the key figures (3) and the completion trend (4)](images/analytics-overview/analytics.en.webp)

1. The tabs: Overview, Journeys, Participants, Groups, Polls, Rewards, Forms and Reports.
2. The period the figures are about.
3. Journeys started, completion rate, average time per step and active participants.
4. How many journeys were started and completed per day.

## Who can open Analytics

Every maker role can open Analytics: Admin, Journey Manager, Editor and Viewer. All roles see all tabs, including Forms. Only an admin can delete results (see "Results of deleted journeys and steps" below) and archived polls.

## Overview

The Analytics page has eight tabs (1):

| Tab | Description |
|-----|-------------|
| Overview | Key figures and trends |
| Journeys | Funnel and step performance of one journey |
| Participants | Progress and activity per participant |
| Groups | Comparison between groups |
| Polls | Poll results |
| Rewards | Reward codes and claims |
| Forms | Form submissions and uploaded files |
| Reports | PDF reports |

[[goto:/dashboard/analytics]]

## Overview Tab

The Overview tab shows key figures (3) for the selected period (2).

### Key figures

| Figure | Description |
|--------|-------------|
| Journeys Started | Journey starts in the period |
| Completion Rate | Of all journeys that participants started in the period, the share they finished |
| Avg. time per step | Average time participants spend on a step |
| Active Participants | Different participants who started a journey in the period |

### Completion Trend

A line chart (4) with the journeys started and completed per day in the selected period.

### Top Performing Journeys

A table of journeys, ranked by the number of completions:
- Journey title
- Started
- Completed
- Rate (completion rate)

### Usage

At the bottom of the Overview tab, **Your Usage** shows how much your organization uses: journeys, AI guides, makers, participants, AI knowledge and AI credits.

## Journeys Tab

See how one journey performs, step by step.

[[goto:/dashboard/analytics#journeys]]

1. Select a journey from the dropdown.
2. Choose the period: Last 7 days, Last 30 days or Last 90 days.

You then see:
- Started, Completed and the completion rate of the journey
- The **Participant Progression Funnel**: how many participants reached each step
- **Step Performance**: a table per step
- **Daily Activity**: a chart of the activity per day

### Step Performance

| Column | Description |
|--------|-------------|
| Step | The step title |
| Type | The step type |
| Reached | Participants who reached the step |
| Completed | Participants who completed the step |
| Avg. Time | Average time spent on the step |
| Drop-off | Percentage who did not continue |

### Export PDF

Click **Export PDF** next to the journey selector to download a Journey Performance Report for the selected journey.

## Participants Tab

Follow the progress of each participant.

[[goto:/dashboard/analytics#users]]

Search by name or email, or pick a group in the **All Groups** dropdown.

The table shows:
- Participant name and email
- Groups (a participant can be in more than one group)
- Journeys completed
- Quiz score (average)
- Last activity

### Participant Details

Click **View Details** on a participant to see:
- Name, email and groups
- Journey Activity: each journey with the number of steps completed
- Quiz Performance: attempts, best score and average score per quiz

Click **Export PDF** in this window to download a progress report of the participant.

### Journey Replay

A replay shows a timeline of one journey of one participant:
- Each step visited, with the time spent
- Quiz attempts and scores
- Form submissions
- Video watch progress
- AI guide chats
- Poll votes

To open a replay:
1. Go to Analytics, tab **Participants**.
2. Search for the participant.
3. Click **View Replay** in the Actions column. Did the participant start more than one journey? Then choose the journey in the dropdown **Replay: choose a journey**.

You can also click **View Replay** next to a journey in **View Details**. A replay is available for every journey the participant started, also when they did not finish it.

## Groups Tab

Compare participant groups.

[[goto:/dashboard/analytics#groups]]

At the top, **Organization Benchmarks** shows the average quiz score and the completion rate of your whole organization.

### Group table

| Column | Description |
|--------|-------------|
| Group | The group name |
| Members | Participants in the group |
| Active | Participants with activity in the period |
| Rate | Completion rate of the group |
| Quiz Score | Average quiz score of the group |
| vs Benchmark | How the group compares to the organization |

### Group Details

Click **View Details** on a group to see:
- The number of members
- Active participants and journeys completed
- Quiz statistics: average score, pass rate and total attempts
- Top Performers: the 10 members with the best results

### Group Comparison

Under the table, choose two groups to compare them in one chart.

## Polls Tab

See the results of the Poll steps in your journeys.

[[goto:/dashboard/analytics#polls]]

See: poll-results

## Rewards Tab

See which reward codes were claimed and how many are left.

[[goto:/dashboard/analytics#rewards]]

See: reward-tracking

## Forms Tab

See the form submissions from Form steps in your journeys, with all answers, who sent them and the uploaded files. You can download the files.

[[goto:/dashboard/analytics#forms]]

See: form-submissions

## Reports Tab

Preview and download PDF reports.

[[goto:/dashboard/analytics#reports]]

See: reports

## Period

The tabs Overview, Journeys and Groups each have their own period selector:
- Last 7 days
- Last 30 days (default)
- Last 90 days

The period (2) only changes the figures on that tab.

## Results of deleted journeys and steps

Results stay in Analytics when a journey is deleted for good from the trash, or when a step is deleted in the builder. This covers progress, quiz scores, poll votes, form submissions and their files, rewards and video statistics.

At the top of Analytics there is a switch **Show deleted journeys and steps**. It is off by default.

- **Off**: Analytics looks as if the deleted journeys and steps are gone.
- **On**: deleted journeys show in the journey lists and selectors, and deleted steps show in the step lists. Both are marked **Deleted**. The sections **Archived Polls** and **Archived Rewards** also only show with the switch on.

With the switch on, the Overview tab shows the card **Deleted journeys and steps**. It has two lists:
- **Journeys deleted for good**, with the number of participants
- **Deleted steps**, with the journey they were in

Only an admin sees the button **Delete results** in this card. Gryffi asks for confirmation first. The results are then removed for good, uploaded files included. You cannot undo this.

Good to know:
- A journey that is deleted for good cannot be restored. Its results only stay in Analytics.
- A journey without any results is removed completely.
- Undo in the builder brings a deleted step back, with its results.
- When you delete a participant, their results are deleted too.
- Completed and expired invitations, with their progress, are still removed after 1 year.

## Related Features

- [[goto:/dashboard/analytics]] - View analytics dashboard
- [[goto:/dashboard/analytics#reports]] - Generate reports
- See: reports, poll-results, reward-tracking, form-submissions, end-user-management, end-user-groups, trash
