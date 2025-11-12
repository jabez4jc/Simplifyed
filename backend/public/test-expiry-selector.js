/**
 * Test Script: Add Instance and Test Expiry Selector
 * Run this in your browser console on the dashboard
 */

(async function testExpirySelector() {
  console.log('🧪 Starting Expiry Selector Test...\n');

  // Step 1: Add the instance
  console.log('📝 Step 1: Adding Flattrade instance...');
  try {
    const addResponse = await fetch('http://localhost:3000/api/v1/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name: 'Flattrade OpenAlgo',
        host_url: 'https://flattrade.simplifyed.in',
        api_key: '9f96b8911d7f4536d2185510e9105f229db01b578082f4c7eefa03395f72c3ab',
        is_active: true,
        order_placement_enabled: true,
        is_analyzer_mode: false
      })
    });

    const addResult = await addResponse.json();

    if (addResult.status === 'success') {
      console.log('✅ Instance added successfully!');
      console.log('   Instance ID:', addResult.data.id);
    } else {
      console.log('⚠️  Instance may already exist or error occurred');
    }
  } catch (error) {
    console.error('❌ Failed to add instance:', error);
  }

  // Step 2: Get active instances
  console.log('\n📝 Step 2: Checking active instances...');
  try {
    const instancesResponse = await fetch('http://localhost:3000/api/v1/instances?is_active=1', {
      credentials: 'include'
    });
    const instancesResult = await instancesResponse.json();

    if (instancesResult.data && instancesResult.data.length > 0) {
      console.log(`✅ Found ${instancesResult.data.length} active instance(s)`);
      instancesResult.data.forEach(inst => {
        console.log(`   - ${inst.name} (ID: ${inst.id})`);
      });
    } else {
      console.log('❌ No active instances found');
      return;
    }
  } catch (error) {
    console.error('❌ Failed to get instances:', error);
    return;
  }

  // Step 3: Test fetching expiries
  console.log('\n📝 Step 3: Testing expiry fetch for NIFTY...');
  try {
    const instancesResponse = await fetch('http://localhost:3000/api/v1/instances?is_active=1', {
      credentials: 'include'
    });
    const instancesResult = await instancesResponse.json();
    const instanceId = instancesResult.data[0].id;

    const expiryResponse = await fetch(
      `http://localhost:3000/api/v1/symbols/expiry?symbol=NIFTY&instanceId=${instanceId}&exchange=NFO`,
      { credentials: 'include' }
    );
    const expiryResult = await expiryResponse.json();

    if (expiryResult.data && expiryResult.data.length > 0) {
      console.log(`✅ Found ${expiryResult.data.length} expiries for NIFTY:`);
      expiryResult.data.slice(0, 5).forEach(exp => {
        console.log(`   - ${exp.expiry || exp}`);
      });
      if (expiryResult.data.length > 5) {
        console.log(`   ... and ${expiryResult.data.length - 5} more`);
      }
    } else {
      console.log('⚠️  No expiries found for NIFTY');
    }
  } catch (error) {
    console.error('❌ Failed to fetch expiries:', error);
  }

  // Step 4: Test the QuickOrderHandler
  console.log('\n📝 Step 4: Testing QuickOrderHandler.fetchAvailableExpiries()...');
  try {
    const expiries = await quickOrder.fetchAvailableExpiries('NIFTY', 'NFO');

    if (expiries && expiries.length > 0) {
      console.log(`✅ QuickOrderHandler fetched ${expiries.length} expiries:`);
      expiries.slice(0, 5).forEach(exp => {
        console.log(`   - ${exp}`);
      });
    } else {
      console.log('❌ QuickOrderHandler returned empty expiries');
    }
  } catch (error) {
    console.error('❌ QuickOrderHandler failed:', error);
  }

  console.log('\n🎉 Test Complete!');
  console.log('\n📋 Next Steps:');
  console.log('   1. Go to Watchlists page');
  console.log('   2. Expand a watchlist');
  console.log('   3. Click ▼ on a symbol');
  console.log('   4. Click FUTURES or OPTIONS button');
  console.log('   5. You should now see the Expiry dropdown! 🎯');
})();
