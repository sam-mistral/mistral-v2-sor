// Example showing SOR with Vault batchSwap and Subgraph pool data, run using: $ TS_NODE_PROJECT='tsconfig.testing.json' ts-node ./test/testScripts/swapExample.ts

require('dotenv').config();
import {
    BigNumber,
    BigNumberish,
    formatFixed,
    parseFixed,
} from '@ethersproject/bignumber';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { Contract } from '@ethersproject/contracts';
import { AddressZero, MaxUint256 } from '@ethersproject/constants';
import {
    PoolDataService,
    SOR,
    SorConfig,
    SwapInfo,
    SwapTypes,
    TokenPriceService,
} from '../../src';
import vaultArtifact from '../../src/abi/Vault.json';
import relayerAbi from '../abi/BatchRelayer.json';
import erc20abi from '../abi/ERC20.json';
import { CoingeckoTokenPriceService } from '../lib/coingeckoTokenPriceService';
import { SubgraphPoolDataService } from '../lib/subgraphPoolDataService';
import { mockPoolDataService } from '../lib/mockPoolDataService';

export enum Network {
    AVALANCHE = 43114
}

export const SOR_CONFIG: Record<Network, SorConfig> = {
    [Network.AVALANCHE]: {
      chainId: Network.AVALANCHE,
      vault: "0x790c681FcE1c7119D78021c740fE444a91c4aBdA",
      weth: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7" // wavax
    }
};

export const PROVIDER_URLS = {
    [Network.AVALANCHE]: `https://rpc.ankr.com/avalanche`
};

export const MULTIADDR: { [chainId: number]: string } = {
    43114: "0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441",
};

export const SUBGRAPH_URLS = {
    [Network.AVALANCHE]: `https://api.thegraph.com/subgraphs/name/sam-mistral/mistral_avalanche`
};

export const ADDRESSES = {
    [Network.AVALANCHE]: {
      AVAX: {
        address: AddressZero,
        decimals: 18,
        symbol: "AVAX"
      },
      USDC: {
        address: "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664",
        decimals: 6,
        symbol: "USDC.e"
      },
      USDT: {
        address: "0xc7198437980c041c805a1edcba50c1ce5db95118",
        decimals: 6,
        symbol: "USDT.e"
      },
      WETH: {
        address: "0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab",
        decimals: 18,
        symbol: "WETH"
      }
    }
};

// This is the same across networks
const vaultAddr = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

async function getSwap(
    provider: JsonRpcProvider,
    config: SorConfig,
    poolDataService: PoolDataService,
    tokenPriceService: TokenPriceService,
    tokenIn: { symbol: string; address: string; decimals: number },
    tokenOut: { symbol: string; address: string; decimals: number },
    swapType: SwapTypes,
    swapAmount: BigNumberish
): Promise<SwapInfo> {
    const sor = new SOR(provider, config, poolDataService, tokenPriceService);

    await sor.fetchPools();

    // gasPrice is used by SOR as a factor to determine how many pools to swap against.
    // i.e. higher cost means more costly to trade against lots of different pools.
    const gasPrice = BigNumber.from('40000000000');
    // This determines the max no of pools the SOR will use to swap.
    const maxPools = 4;

    // This calculates the cost to make a swap which is used as an input to sor to allow it to make gas efficient recommendations.
    // Note - tokenOut for SwapExactIn, tokenIn for SwapExactOut
    const outputToken =
        swapType === SwapTypes.SwapExactOut ? tokenIn : tokenOut;
    const cost = await sor.getCostOfSwapInToken(
        outputToken.address,
        outputToken.decimals,
        gasPrice,
        BigNumber.from('35000')
    );
    const swapInfo: SwapInfo = await sor.getSwaps(
        tokenIn.address,
        tokenOut.address,
        swapType,
        swapAmount,
        { gasPrice, maxPools }
    );

    const amtInScaled =
        swapType === SwapTypes.SwapExactIn
            ? formatFixed(swapAmount, tokenIn.decimals)
            : formatFixed(swapInfo.returnAmount, tokenIn.decimals);
    const amtOutScaled =
        swapType === SwapTypes.SwapExactIn
            ? formatFixed(swapInfo.returnAmount, tokenOut.decimals)
            : formatFixed(swapAmount, tokenOut.decimals);

    const returnDecimals =
        swapType === SwapTypes.SwapExactIn
            ? tokenOut.decimals
            : tokenIn.decimals;

    const returnWithFeesScaled = formatFixed(
        swapInfo.returnAmountConsideringFees,
        returnDecimals
    );

    const costToSwapScaled = formatFixed(cost, returnDecimals);

    const swapTypeStr =
        swapType === SwapTypes.SwapExactIn ? 'SwapExactIn' : 'SwapExactOut';
    console.log(swapTypeStr);
    console.log(`Token In: ${tokenIn.symbol}, Amt: ${amtInScaled.toString()}`);
    console.log(
        `Token Out: ${tokenOut.symbol}, Amt: ${amtOutScaled.toString()}`
    );
    console.log(`Cost to swap: ${costToSwapScaled.toString()}`);
    console.log(`Return Considering Fees: ${returnWithFeesScaled.toString()}`);
    console.log(`Swaps:`);
    console.log(swapInfo.swaps);
    console.log(swapInfo.tokenAddresses);

    return swapInfo;
}

async function makeTrade(
    provider: JsonRpcProvider,
    swapInfo: SwapInfo,
    swapType: SwapTypes
) {
    if (!swapInfo.returnAmount.gt(0)) {
        console.log(`Return Amount is 0. No swaps to exectute.`);
        return;
    }
    const key: any = process.env.TRADER_KEY;
    const wallet = new Wallet(key, provider);

    // if (swapInfo.tokenIn !== AddressZero) {
    //     // Vault needs approval for swapping non ETH
    //     console.log('Checking vault allowance...');
    //     const tokenInContract = new Contract(
    //         swapInfo.tokenIn,
    //         erc20abi,
    //         provider
    //     );

    //     let allowance = await tokenInContract.allowance(
    //         wallet.address,
    //         vaultAddr
    //     );

    //     if (allowance.lt(swapInfo.swapAmount)) {
    //         console.log(
    //             `Not Enough Allowance: ${allowance.toString()}. Approving vault now...`
    //         );
    //         const txApprove = await tokenInContract
    //             .connect(wallet)
    //             .approve(vaultAddr, MaxUint256);
    //         await txApprove.wait();
    //         console.log(`Allowance updated: ${txApprove.hash}`);
    //         allowance = await tokenInContract.allowance(
    //             wallet.address,
    //             vaultAddr
    //         );
    //     }

    //     console.log(`Allowance: ${allowance.toString()}`);
    // }

    const vaultContract = new Contract(vaultAddr, vaultArtifact, provider);
    vaultContract.connect(wallet);

    type FundManagement = {
        sender: string;
        recipient: string;
        fromInternalBalance: boolean;
        toInternalBalance: boolean;
    };

    const funds: FundManagement = {
        sender: wallet.address,
        recipient: wallet.address,
        fromInternalBalance: false,
        toInternalBalance: false,
    };

    const limits: string[] = getLimits(
        swapInfo.tokenIn,
        swapInfo.tokenOut,
        swapType,
        swapInfo.swapAmount,
        swapInfo.returnAmount,
        swapInfo.tokenAddresses
    );
    const deadline = MaxUint256;

    console.log(funds);
    console.log(swapInfo.tokenAddresses);
    console.log(limits);
    console.log('Swapping...');

    const overRides = {};
    // overRides['gasLimit'] = '200000';
    // overRides['gasPrice'] = '20000000000';
    // ETH in swaps must send ETH value
    if (swapInfo.tokenIn === AddressZero) {
        overRides['value'] = swapInfo.swapAmount.toString();
    }

    const deltas = await vaultContract.queryBatchSwap(
        swapType, // SwapType 0=SwapExactIn, 1=SwapExactOut
        swapInfo.swaps,
        swapInfo.tokenAddresses,
        funds
    );
    console.log(deltas.toString());

    // const tx = await vaultContract
    //     .connect(wallet)
    //     .batchSwap(
    //         swapType,
    //         swapInfo.swaps,
    //         swapInfo.tokenAddresses,
    //         funds,
    //         limits,
    //         deadline,
    //         overRides
    //     );

    // console.log(`tx: ${tx.hash}`);
}

function getLimits(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    swapAmount: BigNumber,
    returnAmount: BigNumber,
    tokenAddresses: string[]
): string[] {
    // Limits:
    // +ve means max to send
    // -ve mean min to receive
    // For a multihop the intermediate tokens should be 0
    // This is where slippage tolerance would be added
    const limits: string[] = [];
    const amountIn =
        swapType === SwapTypes.SwapExactIn ? swapAmount : returnAmount;
    const amountOut =
        swapType === SwapTypes.SwapExactIn ? returnAmount : swapAmount;

    tokenAddresses.forEach((token, i) => {
        if (token.toLowerCase() === tokenIn.toLowerCase())
            limits[i] = amountIn.toString();
        else if (token.toLowerCase() === tokenOut.toLowerCase()) {
            limits[i] = amountOut
                .mul('990000000000000000') // 0.99
                .div('1000000000000000000')
                .mul(-1)
                .toString()
                .split('.')[0];
        } else {
            limits[i] = '0';
        }
    });

    return limits;
}

async function makeRelayerTrade(
    provider: JsonRpcProvider,
    swapInfo: SwapInfo,
    swapType: SwapTypes,
    chainId: number
) {
    if (!swapInfo.returnAmount.gt(0)) {
        console.log(`Return Amount is 0. No swaps to exectute.`);
        return;
    }
    const key: any = process.env.TRADER_KEY;
    const wallet = new Wallet(key, provider);

    if (swapInfo.tokenIn !== AddressZero) {
        // Vault needs approval for swapping non ETH
        console.log('Checking vault allowance...');
        const tokenInContract = new Contract(
            swapInfo.tokenIn,
            erc20abi,
            provider
        );

        let allowance = await tokenInContract.allowance(
            wallet.address,
            vaultAddr
        );
        if (allowance.lt(swapInfo.swapAmount)) {
            console.log(
                `Not Enough Allowance: ${allowance.toString()}. Approving vault now...`
            );
            const txApprove = await tokenInContract
                .connect(wallet)
                .approve(vaultAddr, MaxUint256);
            await txApprove.wait();
            console.log(`Allowance updated: ${txApprove.hash}`);
            allowance = await tokenInContract.allowance(
                wallet.address,
                vaultAddr
            );
        }

        console.log(`Allowance: ${allowance.toString()}`);
    }

    const relayerContract = new Contract(
        ADDRESSES[chainId].BatchRelayer.address,
        relayerAbi,
        provider
    );
    relayerContract.connect(wallet);

    type FundManagement = {
        sender: string;
        recipient: string;
        fromInternalBalance: boolean;
        toInternalBalance: boolean;
    };

    const funds: FundManagement = {
        sender: wallet.address,
        recipient: wallet.address,
        fromInternalBalance: false,
        toInternalBalance: false,
    };

    let tokenIn = swapInfo.tokenIn;
    let tokenOut = swapInfo.tokenOut;
    if (swapInfo.tokenIn === ADDRESSES[chainId].STETH.address) {
        tokenIn = ADDRESSES[chainId].wSTETH.address;
    }
    if (swapInfo.tokenOut === ADDRESSES[chainId].STETH.address) {
        tokenOut = ADDRESSES[chainId].wSTETH.address;
    }

    const limits: string[] = getLimits(
        swapInfo.tokenIn,
        swapInfo.tokenOut,
        swapType,
        swapInfo.swapAmount,
        swapInfo.returnAmount,
        swapInfo.tokenAddresses
    );

    const deadline = MaxUint256;

    console.log(funds);
    console.log(swapInfo.tokenAddresses);
    console.log(limits);

    console.log('Swapping...');

    const overRides = {};
    overRides['gasLimit'] = '450000';
    overRides['gasPrice'] = '20000000000';
    // ETH in swaps must send ETH value
    if (swapInfo.tokenIn === AddressZero) {
        overRides['value'] = swapInfo.swapAmountForSwaps?.toString();
    }

    if (swapInfo.swaps.length === 1) {
        console.log('SINGLE SWAP');
        const single = {
            poolId: swapInfo.swaps[0].poolId,
            kind: swapType,
            assetIn: swapInfo.tokenAddresses[swapInfo.swaps[0].assetInIndex],
            assetOut: swapInfo.tokenAddresses[swapInfo.swaps[0].assetOutIndex],
            amount: swapInfo.swaps[0].amount,
            userData: swapInfo.swaps[0].userData,
        };

        if (!swapInfo.returnAmountFromSwaps) return;

        let limit = swapInfo.returnAmountFromSwaps.mul(1.01).toString(); // Max In
        if (swapType === SwapTypes.SwapExactIn)
            limit = swapInfo.returnAmountFromSwaps.mul(0.99).toString(); // Min return

        const tx = await relayerContract
            .connect(wallet)
            .callStatic.swap(single, funds, limit, deadline, overRides);
        console.log(tx.toString());
        console.log(swapInfo.returnAmountFromSwaps.mul(1.01).toString());
    } else {
        const tx = await relayerContract
            .connect(wallet)
            .batchSwap(
                swapType,
                swapInfo.swaps,
                swapInfo.tokenAddresses,
                funds,
                limits,
                deadline,
                overRides
            );
        console.log(`tx:`);
        console.log(tx);
    }
}

export async function simpleSwap() {
    const networkId = Network.AVALANCHE;
    // Pools source can be Subgraph URL or pools data set passed directly
    // Update pools list with most recent onchain balances
    const tokenIn = ADDRESSES[networkId].USDT;
    const tokenOut = ADDRESSES[networkId].USDC;
    const swapType = SwapTypes.SwapExactIn;
    const swapAmount = parseFixed('100', 18);
    const executeTrade = true;

    const provider = new JsonRpcProvider(PROVIDER_URLS[networkId]);

    // This can be useful for debug
    // Fetch & print list of pools from Subgraph
    // let subgraphPools = await fetchSubgraphPools(SUBGRAPH_URLS[networkId]);
    // console.log(`-------`)
    // console.log(JSON.stringify(subgraphPools));
    // console.log(`-------`);

    const subgraphPoolDataService = new SubgraphPoolDataService({
        chainId: networkId,
        vaultAddress: vaultAddr,
        multiAddress: MULTIADDR[networkId],
        provider,
        subgraphUrl: SUBGRAPH_URLS[networkId],
        onchain: true,
    });

    // Use the mock pool data service if you want to use pool data from a file.
    // const poolsSource = require('../testData/testPools/gusdBug.json');
    // mockPoolDataService.setPools(poolsSource);

    const coingeckoTokenPriceService = new CoingeckoTokenPriceService(
        networkId
    );

    // Use the mock token price service if you want to manually set the token price in native asset
    //  mockTokenPriceService.setTokenPrice('0.001');

    const swapInfo = await getSwap(
        provider,
        SOR_CONFIG[Network.AVALANCHE],
        subgraphPoolDataService,
        // mockPoolDataService,
        coingeckoTokenPriceService,
        // mockTokenPriceService,
        tokenIn,
        tokenOut,
        swapType,
        swapAmount
    );

    if (executeTrade) {
          console.log('VAULT SWAP');
          await makeTrade(provider, swapInfo, swapType);
    }
}

// $ TS_NODE_PROJECT='tsconfig.testing.json' ts-node ./test/testScripts/swapExample.ts
simpleSwap();
