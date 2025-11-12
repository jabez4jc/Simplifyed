# Quick Order UI - User Guide

## Overview

The Quick Order feature enables direct trading from watchlist rows without navigating away. Each symbol row can be expanded to reveal trading controls.

## How to Use

### 1. Open Watchlist
- Navigate to the **Watchlists** page from the sidebar
- Click on a watchlist to expand it and view symbols

### 2. Expand Symbol Row
- Click the **▼** button at the start of any symbol row
- The row expands to show trading controls
- Click again (▲) to collapse

### 3. Configure Your Trade

#### Trade Mode Selection
Choose from three trading modes (availability depends on symbol type):
- **EQUITY**: Trade the underlying stock
- **FUTURES**: Trade futures contracts
- **OPTIONS**: Trade options contracts

#### Options Configuration (OPTIONS mode only)
Select strike offset from dropdown:
- **ITM 3/2/1**: In-the-money (3/2/1 strikes away)
- **ATM**: At-the-money (current price)
- **OTM 1/2/3**: Out-of-the-money (1/2/3 strikes away)

#### Quantity
- Enter desired quantity
- System auto-adjusts to lot sizes for F&O

### 4. Execute Trade

#### EQUITY/FUTURES Mode Actions:
- **BUY**: Open long position
- **SELL**: Open short position
- **EXIT**: Close all positions for this symbol

#### OPTIONS Mode Actions:
- **BUY CE**: Buy call option (bullish)
- **SELL CE**: Sell call option (bearish/neutral)
- **BUY PE**: Buy put option (bearish)
- **SELL PE**: Sell put option (bullish/neutral)
- **EXIT**: Close positions at selected strike
- **EXIT ALL**: Close all option positions for underlying

## Features

### Position-Aware Trading
- System automatically checks existing positions
- **OPTIONS Mode**: Closes opposite positions before opening new ones
  - Buying CE/PE closes all short positions first
  - Selling CE/PE closes all long positions first
- Prevents unintended position accumulation

### Multi-Instance Support
- Orders broadcast to all assigned instances
- Shows success/failure summary per instance
- Configurable per-instance or single-instance execution

### Real-Time Updates
- LTP (Last Traded Price) updates every 10 seconds
- Change % shows price movement
- Volume data refreshed automatically

## Symbol Type Indicators

Badges show symbol tradability:
- **INDEX**: Indices (F&O only, no equity)
- **EQUITY_ONLY**: Equity trading only
- **EQUITY_FNO**: All three modes available
- **FUTURES_ONLY**: Futures and options only
- **OPTIONS_ONLY**: Options only
- **UNKNOWN**: Unknown classification

## UI Elements

### Color Coding
- **Green (BUY)**: Open long positions
- **Red (SELL)**: Open short positions
- **Orange (EXIT)**: Close positions
- **Dark Orange (EXIT ALL)**: Close all positions

### Loading States
- Buttons show loading animation during order placement
- Buttons disabled during execution
- Toast notifications confirm success/failure

## Tips

1. **Check Symbol Type**: Ensure the trade mode you select is available for the symbol
2. **Verify Quantity**: System will round to nearest lot size for F&O
3. **Monitor Positions**: Use EXIT actions to quickly close positions
4. **Options Strategy**: Use strike offsets to implement spreads and strategies
5. **Risk Management**: EXIT ALL quickly closes all option legs

## API Integration

The UI calls these backend endpoints:
- `POST /api/v1/quickorders` - Place order
- `GET /api/v1/quickorders` - Order history
- `GET /api/v1/quickorders/stats/summary` - Statistics

## Troubleshooting

### Trade Mode Disabled
- Symbol doesn't support that mode
- Check symbol type badge

### Order Failed
- Check instance connectivity
- Verify order placement enabled on instance
- Ensure sufficient margin/funds
- Check if instance is in analyzer mode

### No Expansion
- Ensure quick-order.js is loaded
- Check browser console for errors
- Verify API connectivity

## Keyboard Shortcuts

_(Future enhancement)_
- `E`: Toggle expansion
- `B`: Quick buy
- `S`: Quick sell
- `X`: Exit position
