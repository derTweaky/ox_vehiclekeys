# ox_vehiclekeys

A high-performance, server-authoritative vehicle locking and hotwiring system for FiveM. Written in TypeScript and built on `ox_core` and `ox_inventory` (keys with unique metadata based on vehicle VIN).

---

## Features

- **⚡ High Performance:** 
  - Monitored seat checks run on a slow 1-second interval loop.
  - Active frame ticks (checking controls/preventing ignition) only run when a player is sitting in the driver's seat of a vehicle they do not have a key for, haven't hotwired, or have manually turned off.
- **🔑 Manual Engine Toggle (`G`):**
  - Drivers can manually start/stop the engine using the configured key (`G`).
  - Synced via entity statebags (`Entity(vehicle).state.engine`).
  - Prevents the vehicle from rolling or moving when the engine is off.
- **🚫 Automatic Seat Shuffle Prevention (`npshuffle`):**
  - Disables the GTA V automatic sliding of passenger peds into the driver seat.
  - Adds the manual `/shuff` chat command to slide over to the driver seat when desired.
- **👑 ox_core Integration:**
  - Database queries fetch ownership details (`owner` column matching character IDs).
  - Automatically queries the database on vehicle creation to fetch registered VINs.
- **🎒 ox_inventory Integration:**
  - Unique keys use `metadata.vin` for pairing.
  - Key duplication at Locksmith shops verifies ownership and charges money directly from the player's cash item (`money`).
  - Bulletproof purchase transactions (with auto-refunds in case of full inventories).
- **🔒 Realistic Locking & Beeping (`L`):**
  - Syncs doors natively (`SetVehicleDoorsLocked`).
  - Plays the Story Mode lock beep sound (`Remote_Lock` from `CORE_NET_EVENTS`) and flashes hazard lights (once for lock, twice for unlock).
  - Plays a key fob animation (`fob_click` from `anim@mp_player_intmenu@key_fob@`) when locking/unlocking outside the vehicle.
- **🔧 Ignition Hotwiring (`H`):**
  - If a player enters a vehicle without a key, the ignition is locked and engine controls are disabled.
  - Pressing `H` triggers a hotwiring mini-game via `lib.skillCheck`.
  - Once hotwired, the engine can be started.

---

## Installation

### Prerequisites
- FiveM Server with **OneSync** enabled.
- **[ox_core](https://github.com/overextended/ox_core)** framework.
- **[ox_lib](https://github.com/overextended/ox_lib)** resource.
- **[ox_inventory](https://github.com/overextended/ox_inventory)** resource.
- **[oxmysql](https://github.com/overextended/oxmysql)** resource.

### 1. Add key item to ox_inventory
Add the following key item definition to your `ox_inventory/data/items.lua` (or custom items configuration):
```lua
['carkey'] = {
	label = 'Car Key',
	weight = 50,
	stack = false, -- MUST be false so each key carries unique metadata
	close = true,
	description = 'A key for an electronic vehicle locking system.'
}
```

### 2. Build Instructions
1. Copy this resource into your server's `resources` directory.
2. Install dependencies:
   ```bash
   bun install
   ```
   *(Or `npm install --legacy-peer-deps`)*
3. Compile the resource:
   ```bash
   bun run build
   ```
   *(Or `npm run build`)*

### 3. server.cfg Configuration
Add the following to your server configuration file:
```cfg
ensure ox_core
ensure ox_lib
ensure ox_inventory
ensure oxmysql
ensure ox_vehiclekeys
```

---

## Configuration (`public/config.json`)

Configure your locksmith shops and key mappings in `public/config.json`:

```json
{
  "locksmiths": [
    {
      "name": "legion_locksmith",
      "coords": [170.15, -1799.32, 28.31, 320.0],
      "ped": "s_m_m_dockwork_01",
      "keyCost": 100,
      "blip": {
        "enabled": true,
        "sprite": 134,
        "color": 3,
        "scale": 0.8,
        "label": "Locksmith"
      }
    }
  ],
  "hotwireKey": "H",
  "lockKey": "L",
  "engineKey": "G",
  "enableLocksmithPeds": true
}
```

- **`locksmiths`**: An array of locksmith locations. Peds (NPCs) and blips will be automatically spawned and managed.
- **`lockKey`**: The key bind (default: `L`) mapped to toggle locks. Can be custom-mapped by players in their GTA V Key Bindings settings under FiveM category.
- **`engineKey`**: The key bind (default: `G`) mapped to start/stop the engine.
- **`hotwireKey`**: The key bind (default: `H`) mapped to start hotwiring when inside a locked ignition vehicle.

---

## Commands

### `/shuff`
Slid over to the next seat manually (useful to slide from passenger to driver's seat).

---

## Giving Keys to Players

To give a physical key item to a player (e.g., in a car dealership, garage, or admin command), use the `ox_inventory` export:
```lua
exports.ox_inventory:AddItem(source, 'carkey', 1, {
    vin = 'YOUR_VEHICLE_VIN_HERE',
    description = 'Key for vehicle with plate ABC 123'
})
```
Make sure to pass the `vin` matching the vehicle's statebag `Entity(vehicle).state.vin`.

---

## Exports for External Scripts

You can interact with the vehicle keys system from other scripts using the exports below.

### Server-side Exports

Manage keys (temporary or inventory checks) on the server (e.g., for vehicle rentals, job vehicles, robbery rewards):

```lua
-- Add a temporary key (doesn't give a physical item, synced to client)
exports.ox_vehiclekeys:AddKey(source, 'YOUR_VEHICLE_VIN_HERE')

-- Remove a temporary key from a player
exports.ox_vehiclekeys:RemoveKey(source, 'YOUR_VEHICLE_VIN_HERE')

-- Check if player has a key (checks BOTH temporary keys and physical carkey items in inventory)
local hasKey = exports.ox_vehiclekeys:HasKey(source, 'YOUR_VEHICLE_VIN_HERE') -- Returns true or false
```

### Client-side Exports

Manage keys locally or register custom lockpicking minigames:

```lua
-- Add a temporary key locally (synced to the server automatically)
exports.ox_vehiclekeys:AddKey('YOUR_VEHICLE_VIN_HERE')

-- Remove a temporary key locally (synced to the server automatically)
exports.ox_vehiclekeys:RemoveKey('YOUR_VEHICLE_VIN_HERE')

-- Check if player has a key locally (checks both temporary keys and physical carkey items)
local hasKey = exports.ox_vehiclekeys:HasKey('YOUR_VEHICLE_VIN_HERE') -- Returns true or false

-- Register a custom lockpicking minigame handler
exports.ox_vehiclekeys:registerMinigame('my_custom_game', function(itemName, itemConfig)
    -- Your minigame logic here
    -- Return true for success (vehicle unlocked), false for failure
    return true
end)
```
