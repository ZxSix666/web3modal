import type {
  CaipAddress,
  CaipNetwork,
  CaipNetworkId,
  ConnectionControllerClient,
  Connector,
  LibraryOptions,
  NetworkControllerClient,
  PublicStateControllerState,
  Token
} from '@web3modal/scaffold'
import { Web3ModalScaffold } from '@web3modal/scaffold'
import {
  ADD_CHAIN_METHOD,
  INJECTED_CONNECTOR_ID,
  NAMESPACE,
  VERSION,
  WALLET_CONNECT_CONNECTOR_ID
} from './utils/constants.js'
import type EthereumProvider from '@walletconnect/ethereum-provider'
import { caipNetworkIdToNumber, getCaipDefaultChain, getCaipTokens } from './utils/helpers.js'
import {
  ConnectorExplorerIds,
  ConnectorImageIds,
  ConnectorNamesMap,
  ConnectorTypesMap,
  NetworkBlockExplorerUrls,
  NetworkImageIds,
  NetworkNames,
  NetworkRPCUrls,
  networkCurrenySymbols
} from './utils/presets.js'
import type { Address, ProviderType } from './utils/types.js'
import { ethers, utils } from 'ethers'
import { ProviderController } from './store/index.js'

// -- Types ---------------------------------------------------------------------
export interface Web3ModalClientOptions extends Omit<LibraryOptions, 'defaultChain' | 'tokens'> {
  ethersConfig: ProviderType
  chains?: number[]
  defaultChain?: number
  chainImages?: Record<number, string>
  tokens?: Record<number, Token>
}

export type Web3ModalOptions = Omit<Web3ModalClientOptions, '_sdkVersion'>

declare global {
  interface Window {
    ethereum?: Record<string, unknown>
  }
}

// @ts-expect-error: Overriden state type is correct
interface Web3ModalState extends PublicStateControllerState {
  selectedNetworkId: number | undefined
}

// -- Client --------------------------------------------------------------------
export class Web3Modal extends Web3ModalScaffold {
  private hasSyncedConnectedAccount = false

  public constructor(options: Web3ModalClientOptions) {
    const { ethersConfig, chains, defaultChain, tokens, chainImages, _sdkVersion, ...w3mOptions } =
      options

    if (!ethersConfig) {
      throw new Error('web3modal:constructor - ethersConfig is undefined')
    }

    if (!w3mOptions.projectId) {
      throw new Error('web3modal:constructor - projectId is undefined')
    }

    if (!ethersConfig.walletConnect) {
      throw new Error('web3modal:constructor - WalletConnectConnector is required')
    }

    const networkControllerClient: NetworkControllerClient = {
      switchCaipNetwork: async caipNetwork => {
        const chainId = caipNetworkIdToNumber(caipNetwork?.id)
        if (chainId) {
          await this.switchNetwork(chainId)
        }
      },

      getApprovedCaipNetworksData(): Promise<{
        approvedCaipNetworkIds: `${string}:${string}`[] | undefined
        supportsAllNetworks: boolean
      }> {
        return new Promise(resolve => {
          const walletChoice = localStorage.getItem('WALLET_ID')
          if (walletChoice?.includes(WALLET_CONNECT_CONNECTOR_ID)) {
            const connector = ethersConfig.walletConnect
            if (!connector) {
              throw new Error(
                'networkControllerClient:getApprovedCaipNetworks - connector is undefined'
              )
            }
            const ns = (ethersConfig.walletConnect?.provider as EthereumProvider).signer?.session
              ?.namespaces
            const nsMethods = ns?.[NAMESPACE]?.methods
            const nsChains = ns?.[NAMESPACE]?.chains

            const result = {
              supportsAllNetworks: nsMethods?.includes(ADD_CHAIN_METHOD) ?? false,
              approvedCaipNetworkIds: nsChains as CaipNetworkId[] | undefined
            }

            resolve(result)
          } else {
            const result = {
              approvedCaipNetworkIds: undefined,
              supportsAllNetworks: true
            }

            resolve(result)
          }
        })
      }
    }

    const connectionControllerClient: ConnectionControllerClient = {
      connectWalletConnect: async onUri => {
        const connector = ethersConfig.walletConnect
        if (!connector) {
          throw new Error('connectionControllerClient:getWalletConnectUri - connector is undefined')
        }

        const walletConnectProvider = connector.provider as EthereumProvider

        walletConnectProvider.on('display_uri', (uri: string) => {
          onUri(uri)
        })

        await walletConnectProvider.connect().then(() => {
          this.setWalletConnectProvider(ethersConfig)
          window?.localStorage.setItem('WALLET_ID', WALLET_CONNECT_CONNECTOR_ID)
        })
      },

      connectExternal: async ({ id }) => {
        if (id === INJECTED_CONNECTOR_ID) {
          const injectedProvider = ethersConfig.injected
          if (!injectedProvider) {
            throw new Error('connectionControllerClient:connectInjected - connector is undefined')
          }

          await injectedProvider.send('eth_requestAccounts', []).then(() => {
            this.setInjectedProvider(ethersConfig)
            window?.localStorage.setItem('WALLET_ID', id)
          })
        }
      },

      checkInjectedInstalled(ids) {
        if (!window?.ethereum) {
          return false
        }

        if (!ids) {
          return Boolean(window.ethereum)
        }

        return ids.some(id => Boolean(window.ethereum?.[String(id)]))
      },

      disconnect: async () => {
        const provider = ProviderController.state.provider
        const providerType = ProviderController.state.providerType

        if (providerType === WALLET_CONNECT_CONNECTOR_ID) {
          const walletConnectProvider = provider?.provider as EthereumProvider
          await walletConnectProvider.disconnect()
          localStorage.removeItem('WALLET_ID')
          ProviderController.reset()
        } else if (providerType === INJECTED_CONNECTOR_ID) {
          localStorage.removeItem('WALLET_ID')
          ProviderController.reset()
        }
      }
    }

    super({
      networkControllerClient,
      connectionControllerClient,
      defaultChain: getCaipDefaultChain(defaultChain),
      tokens: getCaipTokens(tokens),
      _sdkVersion: _sdkVersion ?? `html-wagmi-${VERSION}`,
      ...w3mOptions
    })

    ProviderController.subscribeKey('address', () => {
      this.syncAccount()
    })

    ProviderController.subscribeKey('chainId', () => {
      this.syncNetwork(chainImages)
    })

    this.syncRequestedNetworks(chains, chainImages)
    this.syncConnectors(ethersConfig)

    this.watchWalletConnect(ethersConfig)

    if (ethersConfig.injected) {
      this.watchInjected(ethersConfig)
    }
  }

  // -- Public ------------------------------------------------------------------

  // @ts-expect-error: Overriden state type is correct
  public override getState() {
    const state = super.getState()

    return {
      ...state,
      selectedNetworkId: caipNetworkIdToNumber(state.selectedNetworkId)
    }
  }

  // @ts-expect-error: Overriden state type is correct
  public override subscribeState(callback: (state: Web3ModalState) => void) {
    return super.subscribeState(state =>
      callback({
        ...state,
        selectedNetworkId: caipNetworkIdToNumber(state.selectedNetworkId)
      })
    )
  }

  // -- Private -----------------------------------------------------------------
  private syncRequestedNetworks(
    chains: Web3ModalClientOptions['chains'],
    chainImages?: Web3ModalClientOptions['chainImages']
  ) {
    const requestedCaipNetworks = chains?.map(
      chain =>
        ({
          id: `${NAMESPACE}:${chain}`,
          name: NetworkNames[chain],
          imageId: NetworkImageIds[chain],
          imageUrl: chainImages?.[chain]
        }) as CaipNetwork
    )
    this.setRequestedCaipNetworks(requestedCaipNetworks ?? [])
  }

  private setWalletConnectProvider(config: ProviderType) {
    const walletConnectProvider = config.walletConnect?.provider as EthereumProvider
    if (walletConnectProvider) {
      ProviderController.setAddress(walletConnectProvider.accounts[0] as Address)
      ProviderController.setChainId(walletConnectProvider.chainId)
      ProviderController.setProviderType('walletConnect')
      ProviderController.setProvider(config.walletConnect)
      ProviderController.setIsConnected(true)
    }
  }

  private async setInjectedProvider(config: ProviderType) {
    const injectedProvider = config.injected

    if (injectedProvider) {
      const signer = injectedProvider.getSigner()
      const chainId = await signer.getChainId()
      const address = await signer.getAddress()
      if (address && chainId) {
        ProviderController.setAddress(address as Address)
        ProviderController.setChainId(chainId)
        ProviderController.setProviderType('injected')
        ProviderController.setProvider(config.injected)
        ProviderController.setIsConnected(true)
      }
    }
  }

  private watchWalletConnect(config: ProviderType) {
    const walletConnectProvider = config.walletConnect?.provider as EthereumProvider
    const walletId = localStorage.getItem('WALLET_ID')

    if (walletConnectProvider) {
      if (walletId === WALLET_CONNECT_CONNECTOR_ID) {
        this.setWalletConnectProvider(config)
      }

      walletConnectProvider.on('disconnect', () => {
        localStorage.removeItem('WALLET_ID')
        ProviderController.reset()
      })
    }
  }

  private watchInjected(config: ProviderType) {
    const injectedProvider = config.injected?.provider as EthereumProvider
    const walletId = localStorage.getItem('WALLET_ID')

    if (injectedProvider) {
      if (walletId === INJECTED_CONNECTOR_ID) {
        this.setInjectedProvider(config)
      }

      injectedProvider.on('accountsChanged', accounts => {
        if (accounts.length === 0) {
          localStorage.removeItem('WALLET_ID')
          ProviderController.reset()
        }
      })
    }
  }

  private async syncAccount() {
    const address = ProviderController.state.address
    const chainId = ProviderController.state.chainId
    const isConnected = ProviderController.state.chainId
    this.resetAccount()

    if (isConnected && address && chainId) {
      const caipAddress: CaipAddress = `${NAMESPACE}:${chainId}:${address}`
      this.setIsConnected(Boolean(address))
      this.setCaipAddress(caipAddress)
      await Promise.all([
        this.syncProfile(address),
        this.syncBalance(address),
        this.getApprovedCaipNetworksData()
      ])
      this.hasSyncedConnectedAccount = true
    } else if (!isConnected && this.hasSyncedConnectedAccount) {
      this.resetWcConnection()
      this.resetNetwork()
    }
  }

  private async syncNetwork(chainImages?: Web3ModalClientOptions['chainImages']) {
    const address = ProviderController.state.address
    const chainId = ProviderController.state.chainId
    const isConnected = ProviderController.state.isConnected
    if (chainId) {
      const caipChainId: CaipNetworkId = `${NAMESPACE}:${chainId}`

      this.setCaipNetwork({
        id: caipChainId,
        name: NetworkNames[chainId],
        imageId: NetworkImageIds[chainId],
        imageUrl: chainImages?.[chainId]
      })
      if (isConnected && address) {
        const caipAddress: CaipAddress = `${NAMESPACE}:${chainId}:${address}`
        this.setCaipAddress(caipAddress)
        if (NetworkBlockExplorerUrls[chainId]) {
          const url = `${NetworkBlockExplorerUrls[chainId]}/address/${address}`
          this.setAddressExplorerUrl(url)
        } else {
          this.setAddressExplorerUrl(undefined)
        }
        if (this.hasSyncedConnectedAccount) {
          await this.syncBalance(address)
        }
      }
    }
  }

  private async syncProfile(address: Address) {
    const provider = ProviderController.state.provider
    if (provider) {
      try {
        const name = await provider.lookupAddress(address)
        const avatar = await provider.getAvatar(address)
        if (name) {
          this.setProfileName(name)
        }
        if (avatar) {
          this.setProfileImage(avatar)
        }
      } catch (error) {
        console.log(error)
      }
    }
  }

  private async syncBalance(address: Address) {
    const chainId = ProviderController.state.chainId
    if (chainId) {
      const networkRpcUrl = NetworkRPCUrls[chainId]
      const networkName = NetworkNames[chainId]
      const networkCurreny = networkCurrenySymbols[chainId]

      if (networkRpcUrl && networkName && networkCurreny) {
        const JsonRpcProvider = new ethers.providers.JsonRpcProvider(NetworkRPCUrls[chainId], {
          chainId,
          name: networkName
        })
        if (JsonRpcProvider) {
          const balance = await JsonRpcProvider.getBalance(address)
          const formattedBalance = utils.formatEther(balance)
          this.setBalance(formattedBalance, networkCurreny)
        }
      }
    }
  }

  private async switchNetwork(chainId: number) {
    const provider = ProviderController.state.provider
    const providerType = ProviderController.state.providerType
    if (providerType === WALLET_CONNECT_CONNECTOR_ID) {
      const walletConnectProvider = provider?.provider as EthereumProvider
      if (walletConnectProvider) {
        await walletConnectProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${chainId.toString(16)}` }]
        })
        ProviderController.setChainId(chainId)
      }
    } else if (providerType === INJECTED_CONNECTOR_ID) {
      const injectedProvider = provider
      if (injectedProvider) {
        await injectedProvider.send('wallet_switchEthereumChain', [
          { chainId: `0x${chainId.toString(16)}` }
        ])
        ProviderController.setChainId(chainId)
      }
    }
  }

  private syncConnectors(config: ProviderType) {
    const w3mConnectors: Connector[] = []

    if (config.walletConnect) {
      const connectorType = ConnectorTypesMap[WALLET_CONNECT_CONNECTOR_ID]
      if (connectorType) {
        w3mConnectors.push({
          id: WALLET_CONNECT_CONNECTOR_ID,
          explorerId: ConnectorExplorerIds[WALLET_CONNECT_CONNECTOR_ID],
          imageId: ConnectorImageIds[WALLET_CONNECT_CONNECTOR_ID],
          name: ConnectorNamesMap[WALLET_CONNECT_CONNECTOR_ID],
          type: connectorType
        })
      }
    }

    if (config.injected) {
      const connectorType = ConnectorTypesMap[INJECTED_CONNECTOR_ID]
      if (connectorType) {
        w3mConnectors.push({
          id: INJECTED_CONNECTOR_ID,
          explorerId: ConnectorExplorerIds[INJECTED_CONNECTOR_ID],
          imageId: ConnectorImageIds[INJECTED_CONNECTOR_ID],
          name: ConnectorNamesMap[INJECTED_CONNECTOR_ID],
          type: connectorType
        })
      }

      this.setConnectors(w3mConnectors)
    }
  }
}