'use client'

import { useChat } from 'ai/react'
import { SearchComponent } from './search'
import { ChatInterface } from './chat-interface'
import { SearchResult } from './types'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { useState, useEffect, useRef } from 'react'
import { Settings, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { ErrorDisplay } from '@/components/error-display'

interface MessageData {
  sources: SearchResult[]
  followUpQuestions: string[]
  ticker?: string
}

export default function FireplexityPage() {
  const [sources, setSources] = useState<SearchResult[]>([])
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([])
  const [searchStatus, setSearchStatus] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const lastDataLength = useRef(0)
  const [messageData, setMessageData] = useState<Map<number, MessageData>>(new Map())
  const currentMessageIndex = useRef(0)
  const [currentTicker, setCurrentTicker] = useState<string | null>(null)
  const [firecrawlApiKey, setFirecrawlApiKey] = useState<string>('')
  const [hasApiKey, setHasApiKey] = useState<boolean>(false)
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false)
  const [, setIsCheckingEnv] = useState<boolean>(true)
  const [pendingQuery, setPendingQuery] = useState<string>('')

  // State for custom search domains and time range
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false)
  const [searchDomains, setSearchDomains] = useState<string[]>([])
  const [newDomain, setNewDomain] = useState<string>('')
  const [timeRange, setTimeRange] = useState<string>('all')
  const [modelProvider, setModelProvider] = useState<string>('openai')

  const { messages, input, handleInputChange, handleSubmit, isLoading, data } = useChat({
    api: '/api/fireplexity/search',
    body: {
      ...(firecrawlApiKey && { firecrawlApiKey }),
      ...(searchDomains.length > 0 && { searchDomains }),
      ...(timeRange !== 'all' && { timeRange }),
      modelProvider
    },
    onResponse: () => {
      // Clear status when response starts
      setSearchStatus('')
      // Clear current data for new response
      setSources([])
      setFollowUpQuestions([])
      setCurrentTicker(null)
      // Track the current message index (assistant messages only)
      const assistantMessages = messages.filter(m => m.role === 'assistant')
      currentMessageIndex.current = assistantMessages.length
    },
    onError: (error) => {
      console.error('Chat error:', error)
      setSearchStatus('')
    },
    onFinish: () => {
      setSearchStatus('')
      // Reset data length tracker
      lastDataLength.current = 0
    }
  })

  // Load settings from localStorage on mount
  useEffect(() => {
    const storedDomains = localStorage.getItem('search-domains')
    if (storedDomains) {
      setSearchDomains(JSON.parse(storedDomains))
    }
    const storedTimeRange = localStorage.getItem('search-time-range')
    if (storedTimeRange) {
      setTimeRange(storedTimeRange)
    }
    const storedModelProvider = localStorage.getItem('model-provider')
    if (storedModelProvider) {
      setModelProvider(storedModelProvider)
    }
  }, [])

  const handleAddDomain = () => {
    const trimmedDomain = newDomain.trim();
    if (trimmedDomain && !searchDomains.includes(trimmedDomain)) {
      // Remove http://, https://, and www. from the beginning of the string
      const protocolAndWwwRegex = new RegExp('^(https?://)?(www\\.)?');
      const cleanedDomain = trimmedDomain.replace(protocolAndWwwRegex, '').replace(/\/$/, '');
      
      const updatedDomains = [...searchDomains, cleanedDomain];
      setSearchDomains(updatedDomains);
      localStorage.setItem('search-domains', JSON.stringify(updatedDomains));
      setNewDomain('');
      toast.success(`Added ${cleanedDomain}`);
    }
  };

  const handleRemoveDomain = (domainToRemove: string) => {
    const updatedDomains = searchDomains.filter(domain => domain !== domainToRemove)
    setSearchDomains(updatedDomains)
    localStorage.setItem('search-domains', JSON.stringify(updatedDomains))
    toast.error(`Removed ${domainToRemove}`)
  }

  const handleTimeRangeChange = (value: string) => {
    setTimeRange(value)
    localStorage.setItem('search-time-range', value)
    toast.info(`Time range set to ${value === 'all' ? 'Any Time' : `Past ${value.replace('d', ' day(s)').replace('w', ' week(s)').replace('m', ' month(s)')}`}`)
  }

  // Handle custom data from stream - only process new items
  useEffect(() => {
    if (data && Array.isArray(data)) {
      // Only process new items that haven't been processed before
      const newItems = data.slice(lastDataLength.current)
      
      newItems.forEach((item) => {
        if (!item || typeof item !== 'object' || !('type' in item)) return
        
        const typedItem = item as unknown as { type: string; message?: string; sources?: SearchResult[]; questions?: string[]; symbol?: string }
        if (typedItem.type === 'status') {
          setSearchStatus(typedItem.message || '')
        }
        if (typedItem.type === 'ticker' && typedItem.symbol) {
          setCurrentTicker(typedItem.symbol)
          // Also store in message data map
          const newMap = new Map(messageData)
          const existingData = newMap.get(currentMessageIndex.current) || { sources: [], followUpQuestions: [] }
          newMap.set(currentMessageIndex.current, { ...existingData, ticker: typedItem.symbol })
          setMessageData(newMap)
        }
        if (typedItem.type === 'sources' && typedItem.sources) {
          setSources(typedItem.sources)
          // Also store in message data map
          const newMap = new Map(messageData)
          const existingData = newMap.get(currentMessageIndex.current) || { sources: [], followUpQuestions: [] }
          newMap.set(currentMessageIndex.current, { ...existingData, sources: typedItem.sources })
          setMessageData(newMap)
        }
        if (typedItem.type === 'follow_up_questions' && typedItem.questions) {
          setFollowUpQuestions(typedItem.questions)
          // Also store in message data map
          const newMap = new Map(messageData)
          const existingData = newMap.get(currentMessageIndex.current) || { sources: [], followUpQuestions: [] }
          newMap.set(currentMessageIndex.current, { ...existingData, followUpQuestions: typedItem.questions })
          setMessageData(newMap)
        }
      })
      
      // Update the last processed length
      lastDataLength.current = data.length
    }
  }, [data, messageData])


  // Check for environment variables on mount
  useEffect(() => {
    const checkApiKey = async () => {
      try {
        const response = await fetch('/api/fireplexity/check-env')
        const data = await response.json()
        
        if (data.hasFirecrawlKey) {
          setHasApiKey(true)
        } else {
          // Check localStorage for user's API key
          const storedKey = localStorage.getItem('firecrawl-api-key')
          if (storedKey) {
            setFirecrawlApiKey(storedKey)
            setHasApiKey(true)
          }
        }
      } catch (error) {
        console.error('Error checking environment:', error)
      } finally {
        setIsCheckingEnv(false)
      }
    }
    
    checkApiKey()
  }, [])

  const handleApiKeySubmit = () => {
    if (firecrawlApiKey.trim()) {
      localStorage.setItem('firecrawl-api-key', firecrawlApiKey)
      setHasApiKey(true)
      setShowApiKeyModal(false)
      toast.success('API key saved successfully!')
      
      // If there's a pending query, submit it
      if (pendingQuery) {
        const fakeEvent = {
          preventDefault: () => {},
          currentTarget: {
            querySelector: () => ({ value: pendingQuery })
          }
        } as any
        handleInputChange({ target: { value: pendingQuery } } as any)
        setTimeout(() => {
          handleSubmit(fakeEvent)
          setPendingQuery('')
        }, 100)
      }
    }
  }

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!input.trim()) return
    
    // Check if we have an API key
    if (!hasApiKey) {
      setPendingQuery(input)
      setShowApiKeyModal(true)
      return
    }
    
    setHasSearched(true)
    // Clear current data immediately when submitting new query
    setSources([])
    setFollowUpQuestions([])
    setCurrentTicker(null)
    handleSubmit(e)
  }
  
  // Wrapped submit handler for chat interface
  const handleChatSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    // Check if we have an API key
    if (!hasApiKey) {
      setPendingQuery(input)
      setShowApiKeyModal(true)
      e.preventDefault()
      return
    }
    
    // Store current data in messageData before clearing
    if (messages.length > 0 && sources.length > 0) {
      const assistantMessages = messages.filter(m => m.role === 'assistant')
      const lastAssistantIndex = assistantMessages.length - 1
      if (lastAssistantIndex >= 0) {
        const newMap = new Map(messageData)
        newMap.set(lastAssistantIndex, {
          sources: sources,
          followUpQuestions: followUpQuestions,
          ticker: currentTicker || undefined
        })
        setMessageData(newMap)
      }
    }
    
    // Clear current data immediately when submitting new query
    setSources([])
    setFollowUpQuestions([])
    setCurrentTicker(null)
    handleSubmit(e)
  }

  const isChatActive = hasSearched || messages.length > 0

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header with logo - matching other pages */}
      <header className="px-4 sm:px-6 lg:px-8 py-1 mt-2">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          {/* Removed Firecrawl logo */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSettingsModal(true)}
              className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              <Settings className="w-5 h-5" />
            </Button>

          </div>
        </div>
      </header>

      {/* Hero section - matching other pages */}
      <div className={`px-4 sm:px-6 lg:px-8 pt-2 pb-4 transition-all duration-500 ${isChatActive ? 'opacity-0 h-0 overflow-hidden' : 'opacity-100'}`}>
        <div className="max-w-7xl mx-auto text-center">
          <h1 className="text-[2.5rem] lg:text-[3.8rem] text-[#36322F] dark:text-white font-semibold tracking-tight leading-[1.1] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:200ms] [animation-fill-mode:forwards]">
            <span className="relative px-1 pb-1 text-transparent bg-clip-text bg-gradient-to-tr from-blue-600 to-teal-400 inline-flex justify-center items-center">
              Trip-Advisor AI
            </span>
            <span className="block leading-[1.1] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:400ms] [animation-fill-mode:forwards]">
              Plan Your Next Adventure
            </span>
          </h1>
          <p className="mt-3 text-lg text-zinc-600 dark:text-zinc-400 opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:600ms] [animation-fill-mode:forwards]">
            Your personal AI travel agent for intelligent trip planning and instant destination insights.
          </p>
        </div>
      </div>

      {/* Main content wrapper */}
      <div className="flex-1 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto h-full">
          {!isChatActive ? (
            <SearchComponent 
              handleSubmit={handleSearch}
              input={input}
              handleInputChange={handleInputChange}
              isLoading={isLoading}
            />
          ) : (
            <ChatInterface 
              messages={messages}
              sources={sources}
              followUpQuestions={followUpQuestions}
              searchStatus={searchStatus}
              isLoading={isLoading}
              input={input}
              handleInputChange={handleInputChange}
              handleSubmit={handleChatSubmit}
              messageData={messageData}
              currentTicker={currentTicker}
            />
          )}
        </div>
      </div>

      {/* API Key Modal */}
      <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>API Key Required</DialogTitle>
              <DialogDescription>
                To use Fireplexity search, please enter your API key below.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <Input
                placeholder="Enter your API key"
                value={firecrawlApiKey}
                onChange={(e) => setFirecrawlApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleApiKeySubmit()
                  }
                }}
                className="h-12"
              />
              <Button onClick={handleApiKeySubmit} variant="orange" className="w-full">
                Save API Key
              </Button>
            </div>
          </DialogContent>
        </Dialog>

      {/* Settings Modal */}
      <Dialog open={showSettingsModal} onOpenChange={setShowSettingsModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search Settings</DialogTitle>
            <DialogDescription>
              Customize your search experience. Changes are saved automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="model-provider" className="text-right text-sm font-medium">
                Model
              </label>
              <Select value={modelProvider} onValueChange={(value) => {
                setModelProvider(value)
                localStorage.setItem('model-provider', value)
                toast.info(`Model set to ${value.charAt(0).toUpperCase() + value.slice(1)}`)
              }}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="time-range" className="text-right text-sm font-medium">
                Time Range
              </label>
              <Select value={timeRange} onValueChange={handleTimeRangeChange}>
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Any Time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any Time</SelectItem>
                  <SelectItem value="1d">Past Day</SelectItem>
                  <SelectItem value="7d">Past Week</SelectItem>
                  <SelectItem value="30d">Past Month</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mt-4">
              <h4 className="text-sm font-medium mb-2">Custom Search Domains</h4>
              <div className="flex gap-2">
                <Input 
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="e.g., a.domain.com"
                />
                <Button onClick={handleAddDomain}>Add</Button>
              </div>
              <div className="mt-2 space-y-2">
                {searchDomains.map(domain => (
                  <div key={domain} className="flex items-center justify-between bg-zinc-100 dark:bg-zinc-800 p-2 rounded-md">
                    <span className="text-sm">{domain}</span>
                    <Button variant="ghost" size="icon" onClick={() => handleRemoveDomain(domain)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

// ... (rest of the code remains the same)
    </div>
  )
}