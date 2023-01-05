require('dotenv').config();

const Twitter = require('twitter-lite');
const { TwitterApiFetchUserId } = require('./twitter-api.js');
const {
  checkInDatabase,
  saveToDatabase,
  logTweetCount,
} = require('./tweet-to-db');
const metadata = require('../_data/metadata.js');

//sjh
const { createWriteStream } = require('fs');

const RESULTS_PER_PAGE = 100;
const STOP_FETCH_AT_EXISTING_RECORD_COUNT = 1;

const client = new Twitter({
  version: '2',
  extension: false,
  bearer_token: process.env.TWITTER_BEARER_TOKEN,
});

let requestCount = 0;

async function retrieveTweets(maxId, existingRecordsFound = 0) {
  console.log('Fetching more tweets!', maxId);

  //sjh - we'll write new tweets to this stream
  var newTweetsStream = createWriteStream('database/new-tweets.json', {
    flags: 'a',
  });

  var params = {
    // since_id
    max_results: RESULTS_PER_PAGE,
    expansions: [
      'in_reply_to_user_id',
      'attachments.media_keys',
      'referenced_tweets.id',
      // "referenced_tweets.id.author_id",
      // "entities.mentions.username",
    ].join(','),
    'media.fields': [
      'width',
      'height',
      'alt_text',
      'type',
      'preview_image_url',
      'url',
      // "non_public_metrics",
      // "organic_metrics",
      // "promoted_metrics",
    ].join(','),
    'tweet.fields': [
      'attachments',
      'author_id',
      // "context_annotations",
      'conversation_id',
      'created_at',
      'entities',
      'id',
      'in_reply_to_user_id',
      'lang',
      'public_metrics',
      // "non_public_metrics",
      // "organic_metrics",
      // "promoted_metrics",
      'possibly_sensitive',
      'referenced_tweets',
      'reply_settings',
      'source',
      'text',
      'withheld',
    ].join(','),
  };

  if (maxId) {
    params.until_id = maxId;
  }

  console.log(params);

  let twitterUserId = await TwitterApiFetchUserId(metadata.username);
  console.log('Found userid', twitterUserId);

  console.log(
    'TWITTER REQUEST to statuses/user_timeline (1500/15m)',
    ++requestCount
  );
  let results = await client.get(`users/${twitterUserId}/tweets`, params);
  if (results.errors) {
    console.log('ERRORS', results.errors);
  }

  let tweets = results.data;
  let users = results.includes.users;
  let mediaObjects = results.includes.media;

  console.log(`${tweets.length} tweets found.`);
  // console.log( JSON.stringify(tweets, null, 2) );

  let promises = [];
  for (let tweet of tweets) {
    maxId = tweet.id;
    promises.push(checkInDatabase(tweet));
  }
  let pendingTweets = await Promise.all(promises);

  for (let tweet of pendingTweets) {
    if (tweet === false) {
      existingRecordsFound++;
    } else {
      // sjh instead of saving to the database, we'll write to a file
      //   and then I'll take that file and pre-pend it in tweets.js
      //   so that we don't have to keep running the api call every build!
      // saveToDatabase(tweet, users, media);
      tweet.id_str = tweet.id; //sjh because 11ty uses this field for permalink
      tweet.full_text = tweet.text; //sjh because lots of places in the site use this field
      // sjh vvv because 11ty uses this to identify originals vs replies
      if (tweet?.referenced_tweets?.[0]?.type === 'replied_to') {
        tweet.in_reply_to_status_id = tweet.referenced_tweets[0].id;
        tweet.in_reply_to_status_id_str = tweet.in_reply_to_status_id;
      }
      // sjh vvv because 11ty needs this to capture media
      //  also, this is verbatim copied from tweet-to-db.
      if (tweet.attachments && tweet.attachments.media_keys) {
        tweet.extended_entities = {
          media: [],
        };

        for (let key of tweet.attachments.media_keys) {
          let [media] = mediaObjects.filter((entry) => entry.media_key === key);
          if (media) {
            // aliases for v1
            if (media.type === 'video') {
              // video
              media.media_url_https = media.preview_image_url;
              media.video_info = {
                variants: [
                  {
                    url: media.url,
                  },
                ],
              };
            } else {
              media.media_url_https = media.url;
            }

            tweet.extended_entities.media.push(media);
          } else {
            throw new Error(
              `Media object not found for media key ${key} on tweet ${tweet.id}`
            );
          }
        }
      }

      newTweetsStream.write(`{ "tweet": ${JSON.stringify(tweet, null, 2)} },
`);
    }
  }

  logTweetCount();

  if (existingRecordsFound < STOP_FETCH_AT_EXISTING_RECORD_COUNT) {
    retrieveTweets(maxId, existingRecordsFound);
  } else {
    console.log(
      STOP_FETCH_AT_EXISTING_RECORD_COUNT,
      ' existing records found, stopping.'
    );
    newTweetsStream.end();
  }
}

(async function () {
  try {
    await retrieveTweets();
  } catch (e) {
    console.log('ERROR', e);
  }
})();
