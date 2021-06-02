function insta_function(url) {
    regExp = /((http:\/\/(instagram\.com\/p\/.*\/|www\.instagram\.com\/p\/.*\/))|(https:\/\/(www\.instagram\.com\/p\/.*\/)))/i;
    match = url.match(regExp);
    if (match && match[1].length >= 11) {
        posturl = match[1];
        imgpreview = posturl + 'media?size=l';
        imagehq = posturl + 'media?size=l';
        document.getElementById('imgpreview').src = imgpreview;
        document.getElementById('imagehq').href = imagehq;
    } else {
        alert("The URL you have entered maybe incorrect. Please Enter a correct URL.");
        location.reload();
    }
}
$(document).keypress(function (event) {
    if (event.which == 115 && (event.ctrlKey || event.metaKey) || (event.which == 19)) {
        event.preventDefault();
        return false;
    }
    return true;
});

$("#download-buttons").hide();
$("#imagedloadbtn").click(function () {
    $("#download-buttons").slideDown(500).fadeIn(250);
    $("#imagedloadbtn").hide();
    $(".input-group").hide();
});
