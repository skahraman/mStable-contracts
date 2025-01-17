/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import { formatUnits } from "@ethersproject/units"
import { fullScale } from "@utils/constants"
import { BN, simpleToExactAmount } from "@utils/math"
import { Signer } from "ethers"
import { Contract, Provider } from "ethers-multicall"
import { gql, GraphQLClient } from "graphql-request"
import { task, types } from "hardhat/config"
import { BoostedSavingsVault__factory, Poker, Poker__factory } from "types/generated"
import { getDefenderSigner } from "./utils/defender-utils"
import { deployContract, logTxDetails } from "./utils/deploy-utils"
import { MTA } from "./utils/tokens"

const maxVMTA = simpleToExactAmount(300000, 18)
const maxBoost = simpleToExactAmount(4, 18)
const minBoost = simpleToExactAmount(1, 18)
const floor = simpleToExactAmount(95, 16)

const pokerAddress = "0x8E1Fd7F5ea7f7760a83222d3d470dFBf8493A03F"

const calcBoost = (raw: BN, vMTA: BN, priceCoefficient: BN, boostCoeff: BN, decimals = 18): BN => {
    // min(m, max(d, (d * 0.95) + c * min(vMTA, f) / USD^b))
    const scaledBalance = raw.mul(priceCoefficient).div(simpleToExactAmount(1, decimals))

    if (scaledBalance.lt(simpleToExactAmount(1, decimals))) return minBoost

    let denom = parseFloat(formatUnits(scaledBalance))
    denom **= 0.875
    const flooredMTA = vMTA.gt(maxVMTA) ? maxVMTA : vMTA
    let rhs = floor.add(flooredMTA.mul(boostCoeff).div(10).mul(fullScale).div(simpleToExactAmount(denom)))
    rhs = rhs.gt(minBoost) ? rhs : minBoost
    return rhs.gt(maxBoost) ? maxBoost : rhs
}

type AccountBalance = { [index: string]: BN }
const getAccountBalanceMap = async (accounts: string[], tokenAddress: string, signer: Signer): Promise<AccountBalance> => {
    const abi = ["function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)"]
    const token = new Contract(tokenAddress, abi)

    const ethcallProvider = new Provider(signer.provider)
    await ethcallProvider.init()

    const callPromises = accounts.map((account) => token.balanceOf(account))

    console.log(`About to get vMTA balances for ${accounts.length} accounts`)
    const balances = (await ethcallProvider.all(callPromises)) as BN[]
    const accountBalances: AccountBalance = {}
    balances.forEach((balance, i) => {
        accountBalances[accounts[i]] = balance
    })
    return accountBalances
}

task("over-boost", "Pokes accounts that are over boosted")
    .addOptionalParam("speed", "Defender Relayer speed param: 'safeLow' | 'average' | 'fast' | 'fastest'", "fast", types.string)
    .addFlag("update", "Will send a poke transactions to the Poker contract")
    .addOptionalParam("minMtaDiff", "Min amount of vMTA over boosted", 500, types.int)
    .setAction(async (taskArgs) => {
        const minMtaDiff = simpleToExactAmount(taskArgs.minMtaDiff)
        const signer = await getDefenderSigner(taskArgs.speed)
        // const [signer] = await ethers.getSigners()
        // const signer = await impersonate("0x2f2Db75C5276481E2B018Ac03e968af7763Ed118")

        const gqlClient = new GraphQLClient("https://api.thegraph.com/subgraphs/name/mstable/mstable-feeder-pools")
        const query = gql`
            {
                boostedSavingsVaults {
                    id
                    boostCoeff
                    priceCoeff
                    stakingToken {
                        symbol
                    }
                    accounts(where: { rawBalance_gt: "0" }) {
                        account {
                            id
                        }
                        rawBalance
                        boostedBalance
                        rewardPerTokenPaid
                        rewards
                        lastClaim
                        lastAction
                    }
                }
                _meta {
                    block {
                        number
                    }
                }
            }
        `
        const gqlData = await gqlClient.request(query)

        // eslint-disable-next-line no-underscore-dangle
        const blockNumber = gqlData._meta.block.number
        console.log(`Results for block number ${blockNumber}`)

        // Maps GQL to a list if accounts (addresses) in each vault
        const vaultAccounts = gqlData.boostedSavingsVaults.map((vault) => vault.accounts.map((account) => account.account.id))
        const accountsWithDuplicates = vaultAccounts.flat()
        const accountsUnique = [...new Set<string>(accountsWithDuplicates)]
        const vMtaBalancesMap = await getAccountBalanceMap(accountsUnique, MTA.saving, signer)
        const pokeVaultAccounts: {
            boostVault: string
            accounts: string[]
        }[] = []
        // For each Boosted Vault
        for (const vault of gqlData.boostedSavingsVaults) {
            const boostVault = BoostedSavingsVault__factory.connect(vault.id, signer)
            const priceCoeff = await boostVault.priceCoeff()
            const boostCoeff = await boostVault.boostCoeff()

            const overBoosted: any[] = []
            console.log(
                `\nVault with id ${vault.id} for token ${vault.stakingToken.symbol}, ${vault.accounts.length} accounts, price coeff ${priceCoeff}, boost coeff ${boostCoeff}`,
            )
            console.log("Account, Raw Balance, Boosted Balance, Boost Balance USD, vMTA balance, Boost Actual, Boost Expected, Boost Diff")
            // For each account in the boosted savings vault
            vault.accounts.forEach((account) => {
                const boostActual = BN.from(account.boostedBalance).mul(1000).div(account.rawBalance).toNumber()
                const boostExpected = calcBoost(BN.from(account.rawBalance), vMtaBalancesMap[account.account.id], priceCoeff, boostCoeff)
                    .div(simpleToExactAmount(1, 15))
                    .toNumber()
                const boostDiff = boostActual - boostExpected
                // Calculate how much the boost balance is in USD = balance balance * price coefficient / 1e18
                const boostBalanceUsd = BN.from(account.boostedBalance).mul(priceCoeff).div(simpleToExactAmount(1))
                // Identify accounts with more than 20% over their boost and boost balance > 50,000 USD
                if (boostDiff > 200 && boostBalanceUsd.gt(simpleToExactAmount(50000))) {
                    overBoosted.push({
                        ...account,
                        boostActual,
                        boostExpected,
                        boostDiff,
                        boostBalanceUsd,
                    })
                }
                console.log(
                    `${account.account.id}, ${formatUnits(account.rawBalance)}, ${formatUnits(account.boostedBalance)}, ${formatUnits(
                        boostBalanceUsd,
                    )}, ${formatUnits(vMtaBalancesMap[account.account.id])}, ${formatUnits(boostActual, 3)}, ${formatUnits(
                        boostExpected,
                        3,
                    )}, ${formatUnits(boostDiff, 3)}`,
                )
            })
            console.log(`${overBoosted.length} of ${vault.accounts.length} over boosted for ${vault.id}`)
            overBoosted.forEach((account) => {
                console.log(`${account.account.id} ${formatUnits(account.boostDiff, 3)}, ${formatUnits(account.boostBalanceUsd)}`)
            })
            const pokeAccounts = overBoosted.map((account) => account.account.id)
            console.log(pokeAccounts)
            pokeVaultAccounts.push({
                boostVault: vault.id,
                accounts: pokeAccounts,
            })
        }
        if (taskArgs.update) {
            const poker = Poker__factory.connect(pokerAddress, signer)
            const tx = await poker.poke(pokeVaultAccounts)
            await logTxDetails(tx, "poke Poker")
        }
    })

task("deployPoker", "Deploys the Poker contract").setAction(async (_, hre) => {
    const { network } = hre
    // const [deployer] = await ethers.getSigners()
    const deployer = await getDefenderSigner()

    if (network.name !== "mainnet") throw Error("Invalid network")

    await deployContract<Poker>(new Poker__factory(deployer), "Poker")
})

module.exports = {}
