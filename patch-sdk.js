// patch-sdk.js - 容器内禁用 shared storefront -> adapter 重映射 + enforcement 修复
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

// ========== 1. 禁用 shared storefront -> adapter 重映射 ==========
const p = path.join(cwd, 'node_modules', '@opensea', 'sdk', 'lib', 'utils', 'protocol.js');
if (!fs.existsSync(p)) {
    console.error('❌ 找不到 @opensea/sdk 的 protocol.js');
    process.exit(1);
}
let src = fs.readFileSync(p, 'utf-8');
const old = `const remapSharedStorefrontAddress = (tokenAddress) => {
    if (constants_2.SHARED_STOREFRONT_ADDRESSES.has(tokenAddress.toLowerCase())) {
        return (0, address_1.checksumAddress)(constants_2.SHARED_STOREFRONT_LAZY_MINT_ADAPTER_CROSS_CHAIN_ADDRESS);
    }
    return tokenAddress;
};`;
const neu = `const remapSharedStorefrontAddress = (tokenAddress) => {
    // PATCHED: 禁用 shared storefront -> adapter 重映射（订单签名用真实合约地址）
    return tokenAddress;
};`;
if (src.includes(old)) {
    src = src.replace(old, neu);
    fs.writeFileSync(p, src);
    console.log('✅ protocol.js patched (remap disabled)');
} else if (src.includes('PATCHED: 禁用 shared storefront')) {
    console.log('⏭️  protocol.js already patched');
} else {
    console.error('❌ protocol.js patch pattern not found');
    process.exit(1);
}

// ========== 2. enforcement 修复（fee 2 + required_zone 兜底）==========
const ordersPath = path.join(cwd, 'node_modules', '@opensea', 'sdk', 'lib', 'sdk', 'orders.js');
if (fs.existsSync(ordersPath)) {
    let ordersSrc = fs.readFileSync(ordersPath, 'utf-8');
    let changed = false;

    // 2.1 强制 required_zone（SDK 数据源缺失时用 OpenSea Operator Filter 合约）
    const zoneOld = `        if (collection.requiredZone) {
            zone = collection.requiredZone;
        }`;
    const zoneNew = `        if (collection.requiredZone) {
            zone = collection.requiredZone;
        }
        // PATCH: enforcement 集合 zone 兜底（SDK getNFT 拿不到 collection 时 requiredZone 缺失）
        if (!zone || zone === constants_1.ZERO_ADDRESS) {
            zone = "0x000056f7000000ece9003ca63978907a00ffd100";
        }`;
    if (ordersSrc.includes(zoneOld) && !ordersSrc.includes('enforcement 集合 zone 兜底')) {
        ordersSrc = ordersSrc.replace(zoneOld, zoneNew);
        changed = true;
        console.log('✅ orders.js zone patch applied');
    } else {
        console.log('⏭️  zone patch already applied or pattern not found');
    }

    // 2.2 强制 required fee（fee 2: 0x02ed8db9, 2bp——cryptoapesocialclub 的 enforcement fee）
    const feeMarker = `            considerationFeeItems.push(...getPrivateListingConsiderations(offerAssetItems, buyerAddress));
        }`;
    const feeNew = `            considerationFeeItems.push(...getPrivateListingConsiderations(offerAssetItems, buyerAddress));
        }
        // PATCH: enforcement 集合 required fee 兜底（SDK 数据源缺失 fee 2）
        if (!considerationFeeItems.some(c => c.recipient && String(c.recipient).toLowerCase() === "0x02ed8db986f4c4ce3a73f0ede8e316c1bc90ad07")) {
            considerationFeeItems.push({
                token: paymentTokenAddress,
                amount: (0, utils_1.getAmountWithBasisPointsApplied)(basePrice, 2),
                recipient: "0x02ed8db986f4c4ce3a73f0ede8e316c1bc90ad07",
            });
        }`;
    if (ordersSrc.includes(feeMarker) && !ordersSrc.includes('enforcement 集合 required fee 兜底')) {
        ordersSrc = ordersSrc.replace(feeMarker, feeNew);
        changed = true;
        console.log('✅ orders.js fee patch applied');
    } else {
        console.log('⏭️  fee patch already applied or pattern not found');
    }

    if (changed) {
        fs.writeFileSync(ordersPath, ordersSrc);
        console.log('✅ orders.js saved');
    }
} else {
    console.error('❌ 找不到 orders.js');
    process.exit(1);
}

console.log('✅ patch-sdk.js 完成');
