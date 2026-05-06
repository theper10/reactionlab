# ReactionLab

ReactionLab is a simple reaction time testing website inspired by classic benchmark-style reflex tests. The goal is straightforward: wait for the screen to turn green, then click as fast as possible.

The app measures your reaction speed in milliseconds, tracks your recent attempts, and shows basic stats like your latest time, best time, average time, and total attempts.

## Demo

```text
https://theper10.github.io/reactionlab/
```

## Features

- Reaction time test with randomized delay
- False-start detection if you click too early
- Results measured in milliseconds
- Recent attempt history
- Best, average, latest, and total attempt stats
- Local storage support for saved results
- Reset stats button
- Keyboard support using Space or Enter
- Responsive design for desktop and mobile
- Clean, modern UI with smooth transitions

## How It Works

1. Click the screen to start.
2. Wait until the screen changes color.
3. Click as quickly as possible when it turns green.
4. Your reaction time is displayed in milliseconds.
5. Your score is saved to your recent attempts.

Clicking before the screen turns green counts as a false start.

## Tech Stack

- React
- TypeScript
- Tailwind CSS
- Vite

## Getting Started

### Prerequisites

Make sure you have Node.js installed.

```bash
node -v
npm -v
```

### Installation

Clone the repository:

```bash
git clone https://github.com/theper10/reactionlab.git
```

Go into the project folder:

```bash
cd reactionlab
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the local development URL in your browser.

## Building for Production

To create a production build:

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

## Project Purpose

This project was built as a small interactive web app to practice:

- React state management
- User interaction handling
- Timing with `performance.now()`
- Randomized delays
- Local storage
- Responsive UI design

## Notes on Accuracy

Reaction time results can be affected by several factors, including:

- Monitor refresh rate
- Mouse or keyboard latency
- Touchscreen delay
- Browser performance
- Device speed

Because of this, scores should be treated as a fun estimate rather than a scientific measurement.

## Future Improvements

Possible features to add later:

- Multiplayer 5-round challenge mode
- Leaderboard
- Sound effects
- Dark/light theme toggle
- More detailed statistics
- Graph of recent attempts
- Shareable results

## License

MIT
