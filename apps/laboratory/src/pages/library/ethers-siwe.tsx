import { Center, Text, VStack } from '@chakra-ui/react'
import { NetworksButton } from '../../components/NetworksButton'
import { EthersConnectButton } from '../../components/Ethers/EthersConnectButton'
import { createWeb3Modal, defaultConfig } from '@web3modal/ethers5/react'
import { SiweMessage } from 'siwe'
import { getCsrfToken, getSession, signIn, signOut } from 'next-auth/react'
import { ThemeStore } from '../../utils/StoreUtil'
import {
  arbitrum,
  aurora,
  avalanche,
  base,
  binanceSmartChain,
  celo,
  gnosis,
  mainnet,
  optimism,
  polygon,
  zkSync,
  zora
} from '../../utils/ChainsUtil'
import type { SIWECreateMessageArgs, SIWESession, SIWEVerifyMessageArgs } from '@web3modal/core'
import { createSIWEConfig } from '@web3modal/siwe'

const projectId = process.env['NEXT_PUBLIC_PROJECT_ID']
if (!projectId) {
  throw new Error('NEXT_PUBLIC_PROJECT_ID is not set')
}
const chains = [
  mainnet,
  arbitrum,
  polygon,
  avalanche,
  binanceSmartChain,
  optimism,
  gnosis,
  zkSync,
  zora,
  base,
  celo,
  aurora
]

const metadata = {
  name: 'Web3Modal',
  description: 'Web3Modal Laboratory',
  url: 'https://web3modal.com',
  icons: ['https://avatars.githubusercontent.com/u/37784886']
}

const siweConfig = createSIWEConfig({
  createMessage: ({ nonce, address, chainId }: SIWECreateMessageArgs) =>
    new SiweMessage({
      version: '1',
      domain: window.location.host,
      uri: window.location.origin,
      address,
      chainId,
      nonce,
      // Human-readable ASCII assertion that the user will sign, and it must not contain `\n`.
      statement: 'Sign in With Ethereum.'
    }).prepareMessage(),
  getNonce: async () => {
    const nonce = await getCsrfToken()
    if (!nonce) {
      throw new Error('Failed to get nonce!')
    }

    return nonce
  },
  getSession: async () => {
    const session = await getSession()
    if (!session) {
      throw new Error('Failed to get session!')
    }

    const { address, chainId } = session as unknown as SIWESession

    return { address, chainId }
  },
  verifyMessage: async ({ message, signature }: SIWEVerifyMessageArgs) => {
    try {
      const success = await signIn('credentials', {
        message,
        redirect: false,
        signature,
        callbackUrl: '/protected'
      })

      return Boolean(success?.ok)
    } catch (error) {
      return false
    }
  },
  signOut: async () => {
    try {
      await signOut()

      return true
    } catch (error) {
      return false
    }
  }
})

const modal = createWeb3Modal({
  ethersConfig: defaultConfig({
    metadata,
    defaultChainId: 1,
    rpcUrl: 'https://cloudflare-eth.com'
  }),
  chains,
  projectId,
  enableAnalytics: true,
  metadata,
  siweConfig
})

ThemeStore.setModal(modal)

export default function Ethers() {
  return (
    <>
      <Center paddingTop={10}>
        <Text fontSize="xl" fontWeight={700}>
          V3 with SIWE & Ethers
        </Text>
      </Center>
      <Center h="65vh">
        <VStack gap={4}>
          <EthersConnectButton />
          <NetworksButton />
        </VStack>
      </Center>
    </>
  )
}
