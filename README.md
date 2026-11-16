# Guild War Tracker

A lightweight client-side Fabric mod for **Wynncraft** that records the guild wars you take part in: when you joined, which territory, and whether it ended in a **win**, **loss**, or you **left**. Records are sent automatically to a shared website, so the whole guild can see participation stats in one place.

**Live stats:** https://guild-war-tracker.wartracker.workers.dev

**Download:** [Latest release](https://github.com/podo966/guild-war-tracker/releases/latest)

---

## Features

- **Automatic war detection.** Reads Wynncraft's own war messages and the war tower boss bar. There's nothing to click and no commands to type.
- **Accurate territory names.** The territory comes from the tower boss bar (`[TAG] Territory Tower - ❤ …`), which only players inside the war can see.
- **Ignores wars you weren't in.** Win and loss broadcasts from other guild members are not counted for you.
- **Short chat notifications.** Only three messages are shown:
  ```
  [Guild War] War joined: Entrance to Almuj
  [Guild War] War won: Entrance to Almuj
  [Guild War] War lost: Almuj
  ```
- **Offline-safe.** If the server can't be reached, events are queued on disk and sent later, even after a restart. Events are kept for up to 7 days.
- **Works with or without Wynntils.** The mod reads messages at the network level, so other chat mods don't interfere with it.
- **Shared web dashboard** with:
  - Guild totals: wars joined, wins, losses, left
  - Totals by player, including win rate and last war
  - Full war log with join and end times
  - Filters for player, guild, result and period (today / 7 days / 30 days / all time)
  - Selectable time zone (local, KST, JST, Germany, US, UTC, …)

## How results are decided

| Result | Rule |
|---|---|
| **Joined** | `The battle has begun!` is received. The territory comes from the tower boss bar, or from `The war for … will start` if no boss bar was seen. |
| **Win** | `You have taken control of <territory> from …` |
| **Loss** | `Your guild has lost the war for <territory>.` |
| **Left** | No result within **30 minutes** of joining, **or** you joined another war before this one ended. |

Queueing for a war without the battle actually starting (for example, a territory on cooldown) is **not** counted.

## Installation

1. Install **Fabric Loader** for **Minecraft 1.21.11** ([installer](https://fabricmc.net/use/installer/)).
2. Put these in your `.minecraft/mods` folder:
   - [Fabric API](https://modrinth.com/mod/fabric-api) for 1.21.11
   - `guild-war-tracker-x.x.x.jar` from the [latest release](https://github.com/podo966/guild-war-tracker/releases/latest)
3. Launch the game and join Wynncraft. That's it. The server address is built in.

## What data is sent

Only war events, and only while you are connected to Wynncraft:

| Field | Example |
|---|---|
| Minecraft UUID and username | `PlayerName` |
| Territory | `Entrance to Almuj` |
| Join / end time | `2026-11-16 03:51:35` |
| Result | `win` / `loss` |

Your guild name is looked up by the server from the public [Wynncraft API](https://docs.wynncraft.com/). The mod does not send chat messages, coordinates, or anything else.
