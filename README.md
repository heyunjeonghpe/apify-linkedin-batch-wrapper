# Apify LinkedIn Batch Wrapper Actor

        Lightweight Apify actor that wraps an existing **working Apify task** (your current LinkedIn post scraper task) and runs it across a larger list of LinkedIn profiles in batches.

        ## What it does
        - Accepts a list of LinkedIn profile URLs (e.g. 50 analysts)
        - Calls your existing Apify **task** in batches
        - Pulls dataset items from each task run
        - Normalizes the output into a consistent shape
        - Optionally de-duplicates by post URL
        - Pushes all combined results to the wrapper actor dataset

        ## Why this is useful
        This keeps Apify focused on scraping **all recent posts** while n8n handles:
        - time filtering
        - keyword/content filtering
        - digest generation

        ## Input example
        ```json
        {
          "actorTaskId": "YOUR_EXISTING_TASK_ID",
          "profileUrls": [
            "https://www.linkedin.com/in/wstownsend/",
            "https://www.linkedin.com/in/kltownsend/"
          ],
          "batchSize": 5,
          "maxPostsPerProfile": 15,
          "includeReposts": false,
          "onlyPosts": true,
          "dedupeByPostUrl": true,
          "debug": false
        }
        ```

        ## Output shape
        ```json
        {
          "sourceProfile": "https://www.linkedin.com/in/wstownsend/",
          "authorName": "Will Townsend",
          "authorUrl": "https://www.linkedin.com/in/wstownsend/",
          "text": "I share my insights from Cisco Live 2026...",
          "headline": "I share my insights from Cisco Live 2026...",
          "postUrl": "https://www.linkedin.com/posts/...",
          "postType": "text",
          "timestamp": "2026-06-05T19:22:00.000Z",
          "imageUrl": null,
          "raw": { }
        }
        ```

        ## Deploy on Apify
        1. Create a new Actor in Apify.
        2. Upload this repo.
        3. In the actor input, set `actorTaskId` to the task ID of the LinkedIn post scraper task you already verified works.
        4. Run the actor.
        5. In n8n, call this wrapper actor's `run-sync-get-dataset-items` endpoint.

        ## n8n endpoint pattern
        ```
        POST https://api.apify.com/v2/actor-tasks/YOUR_WRAPPER_TASK_ID/run-sync-get-dataset-items?token=YOUR_API_TOKEN
        ```

        ## Notes
        - This wrapper assumes your existing task accepts these input fields:
          - `profileUrls`
          - `maxPosts`
          - `includeReposts`
          - `onlyPosts`
        - If your source task uses different input names, update the `buildTaskInput()` function in `src/main.js`.
