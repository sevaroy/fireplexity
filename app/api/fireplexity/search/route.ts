import { NextResponse } from 'next/server'
import { createOpenAI } from '@ai-sdk/openai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { streamText, generateText, createDataStreamResponse } from 'ai'
import { detectCompanyTicker } from '@/lib/company-ticker-map'
import { selectRelevantContent } from '@/lib/content-selection'
import FirecrawlApp from '@mendable/firecrawl-js'

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).substring(7)
  console.log(`[${requestId}] Fireplexity Search API called`)
  try {
    const body = await request.json()
    const messages = body.messages || []
    const query = messages[messages.length - 1]?.content || body.query
    const searchDomains = body.searchDomains || []
    const timeRange = body.timeRange || 'all'
    console.log(`[${requestId}] Query received:`, query)

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 })
    }

    // Use API key from request body if provided, otherwise fall back to environment variable
    const firecrawlApiKey = body.firecrawlApiKey || process.env.FIRECRAWL_API_KEY
    const openaiApiKey = process.env.OPENAI_API_KEY
    const deepseekApiKey = process.env.DEEPSEEK_API_KEY
    const modelProvider = body.modelProvider || 'openai'
    
    if (!firecrawlApiKey) {
      return NextResponse.json({ error: 'Firecrawl API key not configured' }, { status: 500 })
    }
    
    let model: any;
    // Use a different model for follow-up questions, always gpt-4o-mini for now
    const openaiFollowup = createOpenAI({ apiKey: openaiApiKey })
    const followUpModel = openaiFollowup('gpt-4o-mini')

    if (modelProvider === 'deepseek') {
      if (!deepseekApiKey) {
        return NextResponse.json({ error: 'DeepSeek API key not configured' }, { status: 500 })
      }
      console.log(`[${requestId}] Using DeepSeek model`)
      const deepseek = createDeepSeek({ apiKey: deepseekApiKey })
      model = deepseek('deepseek-chat')
    } else {
      if (!openaiApiKey) {
        return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 })
      }
      console.log(`[${requestId}] Using OpenAI model`)
      const openai = createOpenAI({ apiKey: openaiApiKey })
      model = openai('gpt-4o-mini')
    }

    // Initialize Firecrawl
    const firecrawl = new FirecrawlApp({ apiKey: firecrawlApiKey })

    // Always perform a fresh search for each query to ensure relevant results
    const isFollowUp = messages.length > 2
    
    // Use createDataStreamResponse with a custom data stream
    return createDataStreamResponse({
      execute: async (dataStream) => {
        try {
          let sources: Array<{
            url: string
            title: string
            description?: string
            content?: string
            markdown?: string
            publishedDate?: string
            author?: string
            image?: string
            favicon?: string
            siteName?: string
          }> = []
          let context = ''
          
          // Always search for sources to ensure fresh, relevant results
          dataStream.writeData({ type: 'status', message: 'Starting search...' })
          dataStream.writeData({ type: 'status', message: 'Searching for relevant sources...' })
            
          const searchOptions: any = {
            limit: 6,
            pageOptions: {},
            scrapeOptions: {
              formats: ['markdown'],
              onlyMainContent: true
            }
          };

          if (timeRange !== 'all') {
            searchOptions.pageOptions.timePublished = timeRange;
            console.log(`[${requestId}] Restricting search to time range:`, timeRange);
          }

          if (searchDomains.length > 0) {
            if (!searchOptions.pageOptions.includePaths) {
              searchOptions.pageOptions.includePaths = [];
            }
            // 使用多種域名格式來提高匹配率
            searchDomains.forEach((domain: string) => {
              searchOptions.pageOptions.includePaths.push(`*://${domain}/**`);
              searchOptions.pageOptions.includePaths.push(`*://*.${domain}/**`);
              searchOptions.pageOptions.includePaths.push(`*://www.${domain}/**`);
            });
            console.log(`[${requestId}] Restricting search to domains:`, searchOptions.pageOptions.includePaths);
          }

          const searchData = await firecrawl.search(query, searchOptions);
          
          // 收集搜索結果
          let searchResults = searchData.data || [];
          
          // 如果指定了域名，對結果進行二次過濾
          if (searchDomains.length > 0 && searchResults.length > 0) {
            console.log(`[${requestId}] Applying secondary domain filter for ${searchDomains.join(', ')}`);
            searchResults = searchResults.filter((item: any) => {
              if (!item.url) return false;
              
              try {
                // 解析URL獲取主機名
                const url = new URL(item.url);
                const hostname = url.hostname;
                
                // 檢查是否匹配任何域名
                return searchDomains.some((domain: string) => 
                  hostname === domain || 
                  hostname === `www.${domain}` || 
                  hostname.endsWith(`.${domain}`)
                );
              } catch (e) {
                console.error(`[${requestId}] Error parsing URL:`, item.url, e);
                return false;
              }
            });
            
            console.log(`[${requestId}] Secondary filter: ${searchResults.length} results remaining`);
            
            // 如果過濾後沒有結果，但原始搜索有結果，表示域名過濾太嚴格
            if (searchResults.length === 0 && searchData.data && searchData.data.length > 0) {
              console.log(`[${requestId}] Warning: All results were filtered out by domain restriction`);
              
              // 發送警告消息到前端
              dataStream.writeData({ 
                type: 'status', 
                message: '⚠️ 沒有找到符合指定域名的結果，請考慮放寬域名限制或嘗試不同的查詢。' 
              });
              
              // 為了讓用戶知道沒有找到符合域名的結果，我們仍然返回空的源清單
              const emptySources: Array<any> = [];
              dataStream.writeData({ type: 'sources', sources: emptySources });
              
              // 將創建一個特殊的提示訊息作為答案
              const domainLimitMessage = `我在 ${searchDomains.join(', ')} 中搜索了「${query}」，但沒有找到符合這些域名的結果。

您可以：
- 嘗試不同的域名
- 放寬域名限制
- 或使用不同的搜索詞`;
              
              // 將這段文本分批寫入以模擬流式回應
              const chunks = domainLimitMessage.split(' ');
              for (const chunk of chunks) {
                dataStream.write(chunk + ' ');
                // 模擬打字效果
                await new Promise(resolve => setTimeout(resolve, 30));
              }
              
              // 提前返回，不繼續處理
              return;
            }
          }
          
          // Transform sources metadata
          sources = searchResults.map((item: any) => ({
            url: item.url,
            title: item.title || item.url,
            description: item.description || item.metadata?.description,
            content: item.content,
            markdown: item.markdown,
            publishedDate: item.publishedDate,
            author: item.author,
            image: item.metadata?.ogImage || item.metadata?.image,
            favicon: item.metadata?.favicon,
            siteName: item.metadata?.siteName,
          })).filter((item: any) => item.url) || []

          // Send sources immediately
          dataStream.writeData({ type: 'sources', sources })
          
          // Small delay to ensure sources render first
          await new Promise(resolve => setTimeout(resolve, 300))
          
          // Update status
          dataStream.writeData({ type: 'status', message: 'Analyzing sources and generating answer...' })
          
          // Detect if query is about a company
          const ticker = detectCompanyTicker(query)
          console.log(`[${requestId}] Query: "${query}" -> Detected ticker: ${ticker}`)
          if (ticker) {
            dataStream.writeData({ type: 'ticker', symbol: ticker })
          }
          
          // Prepare context from sources with intelligent content selection
          context = sources
            .map((source: { title: string; markdown?: string; content?: string; url: string }, index: number) => {
              const content = source.markdown || source.content || ''
              const relevantContent = selectRelevantContent(content, query, 2000)
              return `[${index + 1}] ${source.title}\nURL: ${source.url}\n${relevantContent}`
            })
            .join('\n\n---\n\n')

          console.log(`[${requestId}] Creating text stream for query:`, query)
          console.log(`[${requestId}] Context length:`, context.length)
          
          // Prepare messages for the AI
          let aiMessages = []
          
          if (!isFollowUp) {
            // Initial query with sources
            aiMessages = [
              {
                role: 'system',
                content: `You are 'Trip-Advisor AI', a specialized travel planning assistant. Your goal is to help users discover destinations and plan their perfect trip.
                
                RESPONSE STYLE:
                - Be enthusiastic, inspiring, and helpful.
                - When a user asks about a destination, provide a captivating summary including key attractions, cultural highlights, and unique experiences.
                - For travel planning queries (e.g., "7-day itinerary for Japan"), provide a structured, day-by-day plan.
                - Always consider the user's potential interests (e.g., adventure, relaxation, culture, food).
                - If the query is vague, ask clarifying questions to better understand their travel style and preferences (e.g., "What's your budget?", "Who are you traveling with?").

                FORMAT:
                - Use markdown for clear formatting (e.g., lists for itineraries, bold for key places).
                - Include citations inline like [1], [2] when referencing specific information from the sources.
                - Ensure citations match the source order provided.`
              },
              {
                role: 'user',
                content: `Answer this query: "${query}"\n\nBased on these sources:\n${context}`
              }
            ]
          } else {
            // Follow-up question - still use fresh sources from the new search
            aiMessages = [
              {
                role: 'system',
                content: `You are 'Trip-Advisor AI', continuing a travel planning conversation.
                
                REMEMBER:
                - Maintain your enthusiastic and helpful travel expert persona.
                - Build upon the previous parts of the trip we've planned.
                - Use markdown for clarity.
                - Cite your sources using the [1], [2] format.`
              },
              // Include conversation context
              ...messages.slice(0, -1).map((m: { role: string; content: string }) => ({
                role: m.role,
                content: m.content
              })),
              // Add the current query with the fresh sources
              {
                role: 'user',
                content: `Answer this query: "${query}"\n\nBased on these sources:\n${context}`
              }
            ]
          }
          
          // Start generating follow-up questions in parallel (before streaming answer)
          const conversationPreview = isFollowUp 
            ? messages.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`).join('\n\n')
            : `user: ${query}`
            
          const followUpPromise = generateText({
            model: followUpModel,
            messages: [
              {
                role: 'system',
                content: `You are a travel expert AI. Based on our current conversation, generate 5 insightful follow-up questions to help the user build out their travel plans.\n\n                RULES:\n                - Questions should be genuinely helpful for travel planning (e.g., "Would you like to explore day trips from Tokyo?", "What kind of budget should we plan for accommodation?").\n                - Avoid generic questions. Make them specific to the destinations and activities discussed.\n                - If the conversation is just starting, suggest broad exploratory questions (e.g., "What kind of vibe are you looking for on this trip? Adventure, relaxation, or cultural immersion?").\n                - If no good follow-up questions are possible, return an empty response.\n                - Return only the questions, one per line, no numbering or bullets.`
              },
              {
                role: 'user',
                content: `Query: ${query}\n\nConversation context:\n${conversationPreview}\n\n${sources.length > 0 ? `Available sources about: ${sources.map((s: { title: string }) => s.title).join(', ')}\n\n` : ''}Generate 5 diverse follow-up questions that would help the user learn more about this topic from different angles.`
              }
            ],
            temperature: 0.7,
            maxTokens: 150,
          })
          
          // Stream the text generation
          const result = streamText({
            model: model,
            messages: aiMessages,
            temperature: 0.7,
            maxTokens: 2000
          })
          
          // Merge the text stream into the data stream
          // This ensures proper ordering of text chunks
          result.mergeIntoDataStream(dataStream)
          
          // Wait for both the text generation and follow-up questions
          const [fullAnswer, followUpResponse] = await Promise.all([
            result.text,
            followUpPromise
          ])
          
          // Process follow-up questions
          const followUpQuestions = followUpResponse.text
            .split('\n')
            .map((q: string) => q.trim())
            .filter((q: string) => q.length > 0)
            .slice(0, 5)

          // Send follow-up questions after the answer is complete
          dataStream.writeData({ type: 'follow_up_questions', questions: followUpQuestions })
          
          // Signal completion
          dataStream.writeData({ type: 'complete' })
          
        } catch (error) {
          console.error('Stream error:', error)
          
          // Handle specific error types
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          const statusCode = error && typeof error === 'object' && 'statusCode' in error 
            ? error.statusCode 
            : error && typeof error === 'object' && 'status' in error
            ? error.status
            : undefined
          
          // Provide user-friendly error messages
          const errorResponses: Record<number, { error: string; suggestion?: string }> = {
            401: {
              error: 'Invalid API key',
              suggestion: 'Please check your Firecrawl API key is correct.'
            },
            402: {
              error: 'Insufficient credits',
              suggestion: 'You\'ve run out of Firecrawl credits. Please upgrade your plan.'
            },
            429: {
              error: 'Rate limit exceeded',
              suggestion: 'Too many requests. Please wait a moment and try again.'
            },
            504: {
              error: 'Request timeout',
              suggestion: 'The search took too long. Try a simpler query or fewer sources.'
            }
          }
          
          const errorResponse = statusCode && errorResponses[statusCode as keyof typeof errorResponses] 
            ? errorResponses[statusCode as keyof typeof errorResponses]
            : { error: errorMessage }
          
          const errorData: Record<string, any> = { 
            type: 'error', 
            error: errorResponse.error
          }
          
          if (errorResponse.suggestion) {
            errorData.suggestion = errorResponse.suggestion
          }
          
          if (statusCode) {
            errorData.statusCode = statusCode
          }
          
          dataStream.writeData(errorData)
        }
      },
      headers: {
        'x-vercel-ai-data-stream': 'v1',
      },
    })
    
  } catch (error) {
    console.error('Search API error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : ''
    console.error('Error details:', { errorMessage, errorStack })
    return NextResponse.json(
      { error: 'Search failed', message: errorMessage, details: errorStack },
      { status: 500 }
    )
  }
}