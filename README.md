# Ball Blast — Satisfying Multiply Simulation (Next.js)

A single ball bounces inside a circle. **Every time a ball hits the wall, it multiplies**
(a new ball spawns). As they bounce, they multiply faster and faster — until the circle
**fills up** and everything **blasts** into particles. Then it resets and starts again.

## Open in VS Code & run

1. Unzip and open the folder in VS Code.
2. In the terminal:

```bash
npm install
npm run dev
```

3. Open http://localhost:3000

## How it works

- `app/page.tsx` — the whole simulation on an HTML canvas:
  - **Bounce:** each ball reflects off the circle wall (`v' = v - 2(v·n)n`).
  - **Multiply:** on every wall hit, one new ball is spawned.
  - **Blast:** when the balls fill the circle (their combined area passes a threshold, or
    a safety cap is reached), every ball bursts into particles, then it auto-resets.
- A live **ball counter** and a **Reset** button.

## Tweak it (top of `app/page.tsx`)

- `BALL_RADIUS` — size of each ball
- `BALL_SPEED` — how fast they move
- `MAX_BALLS` — hard safety cap (keeps it 60fps; raise carefully)
- `FILL_RATIO` — how "full" the circle must get before it blasts (0.55 = ~55%)

## Notes

- Uses canvas (not React state per ball) so it stays smooth even with ~150 balls.
- Pauses when the tab is hidden; respects `prefers-reduced-motion` (shows a static circle).

## Deploy

Push to GitHub → import to Vercel.

---

Oddly satisfying. Watch it fill and blast. 💥
