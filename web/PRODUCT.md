# Expenso

Written from the project brief and the approved Phase 4 plan, not from a separate interview.

## What it is

An AI-assisted business expense tool for employees. Tagline: **Snap. Chat. Submit.** Supporting line: *Expenses made effortless.*

It is a home assignment for a Full Stack Engineer position, run as a public demo with fictional data.

## Who uses it, and when

An employee who has just spent money for work (a lunch, a taxi, a subscription) and wants it reported with as little effort as possible: at a desk, or on a phone right after paying. A second audience is the engineers reviewing the assignment, who will spend a few minutes with it and should understand what it does without instructions.

## What they do

- Photograph or upload a receipt and get an expense drafted from it.
- Describe an expense in plain language.
- Correct a draft by talking to it.
- Check company policy before or after spending.
- Review what they have already submitted.

## How it differs

The expense, not the conversation, is the thing on screen. A draft is one persistent object (a "slip") that the conversation changes, rather than a series of chat cards.

## Facts future work must preserve

- Nothing is submitted without the user's explicit confirmation. The language model cannot submit.
- "Submitted" means sent for processing. It never means approved.
- Policy compliance is separate from submission: an expense over its limit can be submitted and is marked for manual review.
- All figures shown come from the backend. No invented metrics.
- USD only. A currency is never assumed from a bare symbol.
- Receipt images are not stored.
- The data and the company policy are fictional, and the interface says so.
- Free-tier services only; the AI service can be slow or briefly unavailable, and the interface says so honestly.

## Platform

Web: desktop and mobile browsers. A Telegram channel sharing the same backend is planned; cross-channel continuity comes later.

## Stack

React, TypeScript, Vite, Tailwind CSS 4. Backend: Hono on Cloudflare Workers, D1.

## Accessibility

WCAG AA contrast, full keyboard operation, state never conveyed by colour alone, reduced-motion respected.
