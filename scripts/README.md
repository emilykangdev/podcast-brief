# How to use the scripts 

# Transcribe                                                                                                                        
`node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"`
                                                                                                                                      
# Generate brief                                                                                                                    
`node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> <transcript.md> <profileId> [--force]`