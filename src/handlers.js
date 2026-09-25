import { csvParseRows, csvFormatRows } from "d3-dsv";

export default {
  google: function(body) {

    var response = JSON.parse(body);

    //Success, return a lat/lng object
    if (response.results && response.results.length) {
      return response.results[0].geometry.location;
    }

    //No match, return a string
    if (response.status === "ZERO_RESULTS" || response.status === "OK") {
      return "NO MATCH";
    }

    var message = response.status + (response.error_message && response.error_message.length ? ": " + response.error_message : "");

    //Temporary problem, worth retrying
    if (response.status === "OVER_QUERY_LIMIT" || response.status === "UNKNOWN_ERROR") {
      return { retry: message };
    }

    //Problem with the API key or account, every row would fail
    if (response.status === "REQUEST_DENIED" || response.status === "OVER_DAILY_LIMIT") {
      return { fatal: message };
    }

    //Other error, return a string
    return message;

  },
  mapbox: function(body) {

    var response = JSON.parse(body);

    if (response.features === undefined) {
      return response.message;
    } else if (!response.features.length) {
      return "NO MATCH";
    }

    return {
      lat: response.features[0].center[1],
      lng: response.features[0].center[0]
    };

  },
  tamu: function(body) {

    var parsed;

    if (!body.length) {
      return "NO RESPONSE BODY RETURNED, CHECK YOUR API KEY";
    }

    try {
      parsed = csvParseRows(body);
    } catch(e) {
      return "ERROR PARSING RESPONSE: "+body;
    }

    if (parsed[0].length < 5) {
      return "UNEXPECTED RESPONSE FORMAT FROM TAMU GEOCODER: "+csvFormatRows([parsed[0]]);
    }

    if (!parsed.length || +parsed[0][2] !== 200 || !+parsed[0][3] || !+parsed[0][4]) {
      return "NO MATCH";
    }

    return {
      lat: parsed[0][3],
      lng: parsed[0][4]
    }

  },
  osm: function(body) {

    var parsed;

    if (!body.length) {
      return "NO RESPONSE BODY RETURNED, CHECK YOUR API KEY";
    }

    try {
      parsed = JSON.parse(body);
    } catch(e) {
      return "ERROR PARSING RESPONSE: "+body;
    }

    if (!Array.isArray(parsed)) {
      return "UNEXPECTED RESPONSE: "+body;
    }

    if (!parsed.length) {
      return "NO MATCH";
    }

    return {
      lat: parsed[0].lat,
      lng: parsed[0].lon
    };

  }
};
