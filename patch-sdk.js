// patch-sdk.js - 容器内禁用 shared storefront -> adapter 重映射（与本地 patch 一致）
const fs = require('fs');
const path = require('path');

const p = path.join(process.cwd(), 'node_modules', '@opensea', 'sdk', 'lib', 'utils', 'protocol.js');
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
    // PATCHED: 禁用 shared storefront -> adapter 重映射（订单必须用原始合约 0x495f 才能进订单簿）
    return tokenAddress;
};`;
if (src.includes(old)) {
    src = src.replace(old, neu);
    fs.writeFileSync(p, src);
    console.log('✅ SDK patched (remap 禁用)');
} else {
    // 可能已被 patch 过
    if (src.includes('PATCHED')) { console.log('✅ SDK 已 patch 过'); }
    else { console.log('⚠️ 未找到原 remap 函数，检查 SDK 版本'); process.exit(1); }
}
